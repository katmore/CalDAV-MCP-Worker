import { afterEach, describe, expect, test, vi } from 'vitest';
import { CalendarServer } from '../src/calendar';
import { TransportError, caldavUrl, guardedFetch, trustedHosts } from '../src/transport';

// These tests drive the real CalDAV client (tsdav) through CalendarServer. The network is
// replaced by a spy on fetch that plays a small CalDAV server, so every request the
// client would send, including its credentials, can be inspected. Nothing leaves the test.

const ROOT = 'https://caldav.example.test/';
const PARTITION = 'https://p1-caldav.example.test/';
const CAL_PATH = '/123/calendars/home/';
const OWNER = { login: 'owner', name: 'Owner', email: 'owner@example.test' };
const ENV = { CALDAV_URL: ROOT, CALDAV_USERNAME: 'user', CALDAV_PASSWORD: 'pass', ALLOWED_GITHUB_LOGIN: 'owner', CALDAV_TRUSTED_HOSTS: '.example.test' };

type Sent = { method: string; url: string; authorized: boolean; headers: Headers; body: string; redirect: string };

const multistatus = (...responses: string[]) =>
  new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${responses.join('')}</d:multistatus>`,
    { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
const response = (href: string, props: string) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const EVENT = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:e1', 'DTSTART:20300103T100000Z', 'DTEND:20300103T110000Z', 'SUMMARY:Existing', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

type Route = (request: Request, url: URL, body: string) => Response | undefined;

// A minimal CalDAV server: discovery, principal, calendar home, one calendar, one event.
// `discovery` decides where /.well-known/caldav sends the client; `override` can replace
// any answer to model misbehaving servers.
function network({ discovery = PARTITION, override }: { discovery?: string | null; override?: Route } = {}) {
  const sent: Sent[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.clone().text();
    sent.push({ method: request.method, url: url.href, authorized: request.headers.has('Authorization'), headers: request.headers, body, redirect: request.redirect });
    const replaced = override?.(request, url, body);
    if (replaced) return replaced;
    if (url.pathname === '/.well-known/caldav') {
      return discovery ? new Response(null, { status: 301, headers: { Location: discovery } }) : new Response(null, { status: 404 });
    }
    if (request.method === 'PROPFIND' && body.includes('current-user-principal')) {
      return multistatus(response(url.pathname, '<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>'));
    }
    if (request.method === 'PROPFIND' && body.includes('calendar-home-set')) {
      return multistatus(response('/123/principal/', '<c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set>'));
    }
    if (request.method === 'PROPFIND' && url.pathname === '/123/calendars/') {
      return multistatus(response(CAL_PATH,
        '<d:displayname>Home</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
        + '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><cs:getctag>1</cs:getctag>'));
    }
    if (request.method === 'REPORT' && url.pathname === CAL_PATH) {
      return multistatus(response(`${CAL_PATH}e1.ics`, `<d:getetag>"1"</d:getetag><c:calendar-data>${EVENT}</c:calendar-data>`));
    }
    if (request.method === 'PUT') return new Response(null, { status: request.headers.has('If-Match') ? 204 : 201 });
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  });
  return { sent, spy };
}

async function tools(env: Record<string, string | undefined> = ENV) {
  const calendar = new CalendarServer(env as any, OWNER);
  const registered: Record<string, { config: any; handler: (args: any) => Promise<any> }> = {};
  (calendar.server as any).registerTool = (name: string, config: any, handler: any) => { registered[name] = { config, handler }; };
  await calendar.init();
  return async (name: string, args: any) => {
    const { config, handler } = registered[name];
    const r = await handler(config.inputSchema.parse(args));
    return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
  };
}

const insecure = (sent: Sent[]) => sent.filter(s => !s.url.startsWith('https://'));
const credentialsTo = (sent: Sent[], host: string) => sent.filter(s => s.authorized && new URL(s.url).hostname === host);

afterEach(() => vi.restoreAllMocks());

describe('CalDAV transport', () => {
  test('refuses an http CALDAV_URL before contacting anything', async () => {
    const { spy } = network();
    const r = await (await tools({ ...ENV, CALDAV_URL: 'http://caldav.example.test/' }))('list_calendars', {});
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatch(/CALDAV_URL must be an https:\/\/ address/);
    expect(spy).not.toHaveBeenCalled();
  });

  test('refuses a CALDAV_URL that is not a URL before contacting anything', async () => {
    const { spy } = network();
    const r = await (await tools({ ...ENV, CALDAV_URL: 'caldav.example.test' }))('list_calendars', {});
    expect(r.body.error).toMatch(/CALDAV_URL must be an https:\/\/ address/);
    expect(spy).not.toHaveBeenCalled();
  });

  test('never follows discovery to an http address', async () => {
    const { sent } = network({ discovery: 'http://caldav.example.test/dav/' });
    await (await tools())('list_calendars', {});
    expect(insecure(sent)).toEqual([]);
  });

  test('never contacts an untrusted host discovery points to, and carries on with the configured one', async () => {
    const { sent } = network({ discovery: 'https://elsewhere.attacker.test/dav/' });
    const r = await (await tools())('list_calendars', {});
    expect(sent.some(s => new URL(s.url).hostname === 'elsewhere.attacker.test')).toBe(false);
    expect(r.body).toEqual([{ id: ROOT.slice(0, -1) + CAL_PATH, name: 'Home' }]);
  });

  test('without CALDAV_TRUSTED_HOSTS, sends credentials only to the configured host', async () => {
    const { sent } = network();
    await (await tools({ ...ENV, CALDAV_TRUSTED_HOSTS: undefined }))('list_calendars', {});
    expect(credentialsTo(sent, 'p1-caldav.example.test')).toEqual([]);
    expect(sent.every(s => new URL(s.url).hostname === 'caldav.example.test')).toBe(true);
  });

  test('follows discovery to a trusted host and works end to end', async () => {
    const { sent } = network();
    const r = await (await tools())('list_calendars', {});
    expect(r.isError).toBe(false);
    expect(r.body).toEqual([{ id: PARTITION.slice(0, -1) + CAL_PATH, name: 'Home' }]);
    expect(credentialsTo(sent, 'p1-caldav.example.test').length).toBeGreaterThan(0);
    expect(insecure(sent)).toEqual([]);
  });

  test('never follows a redirect hop to http, even after an https hop', async () => {
    const { sent } = network({
      override: (request, url) => {
        if (request.method === 'PROPFIND' && url.pathname === '/123/calendars/' && url.hostname === 'p1-caldav.example.test') {
          return new Response(null, { status: 307, headers: { Location: 'https://p2-caldav.example.test/123/calendars/' } });
        }
        if (url.hostname === 'p2-caldav.example.test') {
          return new Response(null, { status: 307, headers: { Location: 'http://p2-caldav.example.test/123/calendars/' } });
        }
      },
    });
    const r = await (await tools())('list_calendars', {});
    expect(r.isError).toBe(true);
    expect(sent.some(s => s.url === 'https://p2-caldav.example.test/123/calendars/')).toBe(true); // the https hop was followed
    expect(insecure(sent)).toEqual([]);
  });

  test('never lets the network follow redirects on its own, where they could not be checked', async () => {
    const { sent } = network();
    await (await tools())('list_calendars', {});
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter(s => s.redirect !== 'manual')).toEqual([]);
  });

  test('never sends credentials to an http address the server lists', async () => {
    const { sent } = network({
      override: (request, url) => {
        if (request.method === 'PROPFIND' && url.pathname === '/123/calendars/') {
          return multistatus(response('http://p1-caldav.example.test/123/calendars/home/',
            '<d:displayname>Home</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>'));
        }
      },
    });
    const r = await (await tools())('list_calendars', {});
    expect(r.body).toEqual({ error: 'CalDAV operation failed', reason: 'TransportError' });
    expect(insecure(sent)).toEqual([]);
  });

  test('keeps version checks on writes: create never overwrites, update and delete send the version', async () => {
    const { sent } = network();
    const call = await tools();
    const calendarId = PARTITION.slice(0, -1) + CAL_PATH;
    const resourceId = `${calendarId}e1.ics`;
    const created = await call('create_event', { calendarId, title: 'New', start: '2030-01-04T10:00:00Z', end: '2030-01-04T11:00:00Z' });
    expect(created.body.created).toBe(true);
    expect((await call('update_event', { calendarId, resourceId, etag: '"1"', title: 'Renamed' })).body.updated).toBe(true);
    expect((await call('delete_event', { calendarId, resourceId, etag: '"1"', confirm: 'DELETE' })).body.deleted).toBe(true);
    const [put, update] = sent.filter(s => s.method === 'PUT');
    expect(put.headers.get('If-None-Match')).toBe('*');
    expect(update.headers.get('If-Match')).toBe('"1"');
    expect(update.body).toContain('SUMMARY:Renamed');
    expect(sent.find(s => s.method === 'DELETE')!.headers.get('If-Match')).toBe('"1"');
    expect(insecure(sent)).toEqual([]);
    expect(sent.every(s => s.authorized)).toBe(true);
  });

  test('reports a transport refusal without revealing addresses or credentials', async () => {
    const { sent } = network({
      override: (request, url) => {
        if (request.method === 'PROPFIND' && url.pathname === '/123/calendars/') {
          return new Response(null, { status: 307, headers: { Location: 'https://user:pass@elsewhere.attacker.test/123/calendars/' } });
        }
      },
    });
    const r = await (await tools())('list_calendars', {});
    expect(r.body).toEqual({ error: 'CalDAV operation failed', reason: 'TransportError' });
    expect(sent.some(s => s.url.includes('attacker'))).toBe(false);
  });
});

describe('trusted hosts', () => {
  const configured = new URL('https://caldav.example.test/');

  test('always trusts the configured host, and only that by default', () => {
    const trusted = trustedHosts(configured, undefined);
    expect(trusted('caldav.example.test')).toBe(true);
    expect(trusted('CalDAV.Example.Test')).toBe(true);
    expect(trusted('p1-caldav.example.test')).toBe(false);
    expect(trusted('example.test')).toBe(false);
  });

  test('a leading dot trusts a domain and everything under it; otherwise the name must match exactly', () => {
    const trusted = trustedHosts(configured, ' .Partner.Test, exact.other.test ');
    expect(trusted('partner.test')).toBe(true);
    expect(trusted('a.b.partner.test')).toBe(true);
    expect(trusted('evilpartner.test')).toBe(false);
    expect(trusted('exact.other.test')).toBe(true);
    expect(trusted('sub.exact.other.test')).toBe(false);
  });

  test.each(['https://x.test', 'x.test/path', 'x.test:443', '*.x.test', 'user@x.test'])('rejects %s as a host entry', entry => {
    expect(() => trustedHosts(configured, entry)).toThrow(/CALDAV_TRUSTED_HOSTS must list host names/);
  });

  test('CALDAV_URL must be an https address', () => {
    expect(caldavUrl(' https://caldav.example.test/dav/ ').href).toBe('https://caldav.example.test/dav/');
    expect(() => caldavUrl(undefined)).toThrow(/must be set/);
    expect(() => caldavUrl('http://caldav.example.test/')).toThrow(/https/);
    expect(() => caldavUrl('caldav.example.test')).toThrow(/https/);
  });
});

describe('guarded fetch redirects', () => {
  type Hop = { status: number; location?: string };
  // Plays a fixed sequence of responses and records the requests made.
  function scripted(...hops: Hop[]) {
    const requests: { method: string; url: string; body: string; redirect: string; contentType: string | null }[] = [];
    const send = async (request: Request) => {
      requests.push({ method: request.method, url: request.url, body: await request.text(), redirect: request.redirect, contentType: request.headers.get('Content-Type') });
      const hop = hops.shift() ?? { status: 200 };
      return new Response(null, { status: hop.status, headers: hop.location ? { Location: hop.location } : {} });
    };
    return { requests, fetch: guardedFetch(() => true, send) };
  }
  const propfind = { method: 'PROPFIND', body: '<propfind/>', headers: { 'Content-Type': 'text/xml' } };

  test('resolves a relative redirect against the current address, keeping method and body for 307 and 308', async () => {
    const { requests, fetch } = scripted({ status: 307, location: '/next/' }, { status: 308, location: 'final/' });
    expect((await fetch('https://a.test/start/', propfind)).status).toBe(200);
    expect(requests.map(r => [r.method, r.url, r.body])).toEqual([
      ['PROPFIND', 'https://a.test/start/', '<propfind/>'],
      ['PROPFIND', 'https://a.test/next/', '<propfind/>'],
      ['PROPFIND', 'https://a.test/next/final/', '<propfind/>'],
    ]);
    expect(requests.every(r => r.redirect === 'manual')).toBe(true);
  });

  test('turns a 303 into a GET without a body', async () => {
    const { requests, fetch } = scripted({ status: 303, location: '/other' });
    await fetch('https://a.test/', propfind);
    expect(requests[1]).toMatchObject({ method: 'GET', body: '', contentType: null });
  });

  test('stops a redirect loop', async () => {
    const { requests, fetch } = scripted(...Array.from({ length: 10 }, () => ({ status: 302, location: '/loop' })));
    await expect(fetch('https://a.test/loop')).rejects.toThrow(/Too many CalDAV redirects/);
    expect(requests.length).toBe(6);
  });

  test('returns redirects to a caller that handles them itself, and passes other responses through', async () => {
    expect((await scripted({ status: 301, location: '/x' }).fetch('https://a.test/', { redirect: 'manual' })).status).toBe(301);
    expect((await scripted({ status: 302 }).fetch('https://a.test/')).status).toBe(302);
    expect((await scripted({ status: 304, location: '/x' }).fetch('https://a.test/')).status).toBe(304);
  });

  test('refuses addresses that are not https, carry credentials, or are not trusted', async () => {
    const send = vi.fn(async () => new Response(null));
    const fetch = guardedFetch(host => host === 'a.test', send);
    for (const url of ['http://a.test/', 'https://u:p@a.test/', 'https://b.test/']) {
      await expect(fetch(url)).rejects.toThrow(TransportError);
    }
    expect(send).not.toHaveBeenCalled();
  });
});
