#!/usr/bin/env node
// End-to-end smoke test of a deployed Worker, run from your own machine.
//
//   npm run smoke -- --url https://<worker-name>.<your-subdomain>.workers.dev --calendar "Home"
//
// It signs in the way an MCP client does (identifies itself, opens your browser to approve
// and sign in with GitHub, receives the code on a local port), then calls the calendar
// tools directly: list calendars, create a test event a week from now, read it, edit it,
// find it in a listing, delete it and confirm it is gone. The test event is deleted even if
// a step fails. The access token is kept in memory only.
//
// To identify itself it uses the client metadata document in oauth/smoke-test-client.json,
// published from this repository, when the Worker supports that; otherwise it registers.
// --register forces registration, and --client-id points at a different document.
//
// SMOKE_URL and SMOKE_CALENDAR can be used instead of --url and --calendar.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    calendar: { type: 'string' },
    'client-id': { type: 'string' },
    register: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
const base = (args.url ?? process.env.SMOKE_URL ?? '').replace(/\/+$/, '');
const calendarName = args.calendar ?? process.env.SMOKE_CALENDAR;
const CLIENT_DOCUMENT = 'https://raw.githubusercontent.com/katmore/CalDAV-MCP-Worker/main/oauth/smoke-test-client.json';
if (args.help || !base) {
  console.log('usage: npm run smoke -- --url https://<worker>.<subdomain>.workers.dev [--calendar "<name>"] [--register | --client-id <document URL>]');
  process.exit(args.help ? 0 : 2);
}

let failures = 0;
const pass = message => console.log(`✔ ${message}`);
const fail = message => { console.log(`✖ ${message}`); failures++; };

async function json(response, what) {
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

// Opens the default browser; the address is also printed in case that doesn't work.
function openBrowser(url) {
  const [command, commandArgs] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  spawn(command, commandArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// Listens on a random local port for the browser to come back with the sign-in code.
async function startCallbackServer(state) {
  let settle;
  const code = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
    const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
    response.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain' })
      .end(ok ? 'Signed in. You can close this tab and return to the terminal.' : 'Sign-in failed. Check the terminal.');
    if (ok) settle.resolve(url.searchParams.get('code'));
    else settle.reject(new Error(`sign-in failed: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'state mismatch'}`));
  });
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  const timer = setTimeout(() => settle.reject(new Error('timed out waiting for sign-in (5 minutes)')), 5 * 60_000);
  return {
    redirectUri: `http://127.0.0.1:${server.address().port}/callback`,
    code: code.finally(() => { clearTimeout(timer); server.close(); }),
  };
}

// Identifies this script to the Worker, either by its metadata document or by registering.
async function clientId(metadata, redirectUri) {
  if (!args.register && metadata.client_id_metadata_document_supported) {
    console.log('Identifying with the client metadata document.');
    return args['client-id'] ?? CLIENT_DOCUMENT;
  }
  if (!metadata.registration_endpoint) throw new Error('the Worker supports neither client metadata documents nor registration');
  console.log('Registering as a new app.');
  const client = await json(await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'CalDAV MCP Worker smoke test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  }), 'client registration');
  return client.client_id;
}

// Has you sign in through the browser and returns an access token.
async function signIn() {
  const metadata = await json(await fetch(`${base}/.well-known/oauth-authorization-server`), 'OAuth discovery');
  const state = randomBytes(16).toString('base64url');
  const callback = await startCallbackServer(state);
  const client = { client_id: await clientId(metadata, callback.redirectUri) };

  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(metadata.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: client.client_id, redirect_uri: callback.redirectUri, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  })) authorize.searchParams.set(key, value);

  console.log(`Opening your browser to approve "CalDAV MCP Worker smoke test" and sign in with GitHub.\nIf it doesn't open, visit:\n${authorize}\n`);
  openBrowser(authorize.href);
  const code = await callback.code;

  const token = await json(await fetch(metadata.token_endpoint, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback.redirectUri, client_id: client.client_id, code_verifier: verifier }),
  }), 'token exchange');
  return token.access_token;
}

// Calls one MCP tool and returns its parsed result. The server may answer as JSON or as a
// one-event stream.
let rpcId = 0;
async function tool(accessToken, name, toolArgs) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: toolArgs } }),
  });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const text = await response.text();
  const message = JSON.parse(response.headers.get('Content-Type')?.includes('text/event-stream')
    ? text.split('\n').find(line => line.startsWith('data: ')).slice(6)
    : text);
  if (message.error) throw new Error(`${name}: ${message.error.message}`);
  return { isError: !!message.result.isError, body: JSON.parse(message.result.content[0].text) };
}

const minutesFrom = (date, minutes) => new Date(date.getTime() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function run(accessToken) {
  const calendars = await tool(accessToken, 'list_calendars', {});
  if (calendars.isError) { fail(`list calendars: ${JSON.stringify(calendars.body)}`); return; }
  pass(`list calendars (${calendars.body.length} found)`);
  const calendar = calendars.body.find(c => c.name === calendarName);
  if (!calendar) {
    if (calendarName) fail(`no calendar named "${calendarName}"`);
    console.log(`\nChoose a calendar to test in with --calendar. Available:\n${calendars.body.map(c => `  ${c.name}`).join('\n')}`);
    return 'no calendar';
  }

  // A 15-minute event a week from now, on the hour, so it is easy to spot and out of the way.
  const start = new Date(Date.now() + 7 * 86_400_000);
  start.setUTCMinutes(0, 0, 0);
  const title = `Connector smoke test ${new Date().toISOString().slice(0, 16)}`;
  let resourceId, etag;
  try {
    const created = await tool(accessToken, 'create_event', { calendarId: calendar.id, title, start: minutesFrom(start, 0), end: minutesFrom(start, 15) });
    if (created.isError || !created.body.created) { fail(`create event: ${JSON.stringify(created.body)}`); return; }
    resourceId = created.body.resourceId;
    etag = created.body.etag;
    pass(`create event "${title}" (read-back ${created.body.verification})`);

    const read = await tool(accessToken, 'get_event', { calendarId: calendar.id, resourceId });
    etag = read.body.etag ?? etag;
    read.body.events?.[0]?.title === title ? pass('read it back') : fail(`read it back: ${JSON.stringify(read.body)}`);

    const newTitle = `${title} (edited)`;
    const updated = await tool(accessToken, 'update_event', { calendarId: calendar.id, resourceId, etag, title: newTitle, start: minutesFrom(start, 30), end: minutesFrom(start, 45) });
    updated.body.updated ? pass('rename and move it 30 minutes later') : fail(`edit it: ${JSON.stringify(updated.body)}`);

    const listed = await tool(accessToken, 'list_events', { calendarId: calendar.id, start: minutesFrom(start, -60), end: minutesFrom(start, 120) });
    const found = listed.body.occurrences?.find(o => o.resourceId === resourceId);
    found?.title === newTitle && found.start === new Date(minutesFrom(start, 30)).toISOString()
      ? pass('find the edited event in a listing')
      : fail(`find it in a listing: ${JSON.stringify(found ?? listed.body)}`);
  } finally {
    if (resourceId) {
      const current = await tool(accessToken, 'get_event', { calendarId: calendar.id, resourceId });
      const deleted = await tool(accessToken, 'delete_event', { calendarId: calendar.id, resourceId, etag: current.body.etag ?? etag, confirm: 'DELETE' });
      deleted.body.deleted ? pass('delete it') : fail(`delete it (remove "${title}" by hand): ${JSON.stringify(deleted.body)}`);
      const gone = await tool(accessToken, 'get_event', { calendarId: calendar.id, resourceId });
      gone.isError ? pass('confirm it is gone') : fail('confirm it is gone: it can still be read');
    }
  }
}

let outcome;
try {
  outcome = await run(await signIn());
} catch (error) {
  fail(error.message);
}
if (failures) console.log(`\n${failures} check(s) failed.`);
else if (outcome === 'no calendar') console.log('\nSigned in and listed calendars; nothing else was tested.');
else console.log('\nAll checks passed.');
process.exit(failures ? 1 : outcome === 'no calendar' ? 2 : 0);
