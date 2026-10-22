import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import worker from '../src/index';

const BASE = 'https://worker.example.test';
const CLIENT_CB = 'https://client.example.test/cb';
const CLIENT_DOC = 'https://client.example.test/oauth/client.json';

async function call(request: Request, overrides: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, ...overrides } as any, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const cookieValues = (response: Response) => response.headers.getSetCookie().map(c => c.split(';')[0]);

// Fakes the outside world: GitHub's token endpoint and user API (which, like GitHub, only
// answer for the token issued), and an app's client metadata document.
function network({ login = 'owner', clientDoc }: { login?: string; clientDoc?: Record<string, unknown> } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url === CLIENT_DOC && clientDoc) return Response.json(clientDoc);
    if (request.url === 'https://github.com/login/oauth/access_token') {
      return new Response('access_token=gh-token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    }
    if (request.url === 'https://api.github.com/user') {
      return /^(token|bearer) gh-token$/i.test(request.headers.get('Authorization') ?? '')
        ? Response.json({ login, name: 'Owner Name', email: 'owner@example.test' })
        : Response.json({ message: 'Bad credentials' }, { status: 401 });
    }
    throw new Error(`unexpected fetch ${request.url}`);
  });
}

type SignInOptions = { login?: string; tamperState?: (state: any) => any; keepBinding?: boolean; clientDoc?: Record<string, unknown> };

// Runs the whole sign-in as an MCP client would: register (or, with clientDoc, identify
// itself by a metadata document URL instead), approve, GitHub, token.
async function signIn({ login = 'owner', tamperState, keepBinding = true, clientDoc }: SignInOptions = {}) {
  network({ login, clientDoc });
  let client_id = CLIENT_DOC;
  if (!clientDoc) {
    const registered = await call(new Request(`${BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [CLIENT_CB], token_endpoint_auth_method: 'none' }),
    }));
    expect(registered.status).toBe(201);
    client_id = (await registered.json() as { client_id: string }).client_id;
  }

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const authorizeUrl = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id, redirect_uri: CLIENT_CB, code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state' })) {
    authorizeUrl.searchParams.set(k, v);
  }

  const page = await call(new Request(authorizeUrl));
  expect(page.status).toBe(200);
  const html = await page.text();
  const field = (name: string) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))![1];

  const state0 = tamperState ? btoa(JSON.stringify(tamperState(JSON.parse(atob(field('state')))))) : field('state');
  const approved = await call(new Request(`${BASE}/authorize`, {
    method: 'POST',
    headers: { Cookie: cookieValues(page).join('; ') },
    body: new URLSearchParams({ state: state0, csrf_token: field('csrf_token') }),
  }));
  expect(approved.status).toBe(302);
  const state = new URL(approved.headers.get('Location')!).searchParams.get('state')!;

  const approvedCookies = cookieValues(approved);
  const bindingOnly = approvedCookies.filter(c => c.startsWith('__Host-OAUTH_STATE='));
  const callback = await call(new Request(`${BASE}/callback?code=gh-code&state=${state}`, { headers: keepBinding ? { Cookie: bindingOnly.join('; ') } : {} }));
  const result = { callback, approvedCookies, authorizeUrl };
  if (callback.status !== 302) { vi.restoreAllMocks(); return result; }
  const redirect = new URL(callback.headers.get('Location')!);
  expect(redirect.origin + redirect.pathname).toBe(CLIENT_CB);
  expect(redirect.searchParams.get('state')).toBe('client-state');

  const token = await call(new Request(`${BASE}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, redirect_uri: CLIENT_CB, client_id, code_verifier: verifier }),
  }));
  vi.restoreAllMocks();
  expect(token.status).toBe(200);
  const { access_token } = await token.json() as { access_token: string };
  return { ...result, accessToken: access_token };
}

const rpc = (accessToken: string | undefined, method: string, params: unknown = {}) =>
  new Request(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

// The MCP handler may answer as JSON or as a one-event stream.
async function rpcResult(response: Response) {
  const text = await response.text();
  const json = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? text.split('\n').find(line => line.startsWith('data: '))!.slice(6)
    : text;
  return JSON.parse(json);
}

afterEach(() => vi.restoreAllMocks());

describe('Worker entry point', () => {
  test('refuses MCP requests without a token', async () => {
    const response = await call(rpc(undefined, 'tools/list'));
    expect(response.status).toBe(401);
  });

  test('only advertises S256 PKCE', async () => {
    const response = await call(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    expect((await response.json() as any).code_challenge_methods_supported).toEqual(['S256']);
  });

  test('advertises both client metadata documents and registration', async () => {
    const metadata = await (await call(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json() as any;
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.registration_endpoint).toBe(`${BASE}/register`);
  });

  test('does not let another GitHub account finish signing in', async () => {
    const { callback } = await signIn({ login: 'someone-else' });
    expect(callback.status).toBe(403);
  });

  test('does not finish a sign-in in a browser that did not start it', async () => {
    const { callback } = await signIn({ keepBinding: false });
    expect(callback.status).toBe(400);
  });

  test('never sends a sign-in code to an address the client did not register', async () => {
    const attacker = 'https://attacker.example.test/steal';
    const { callback } = await signIn({ tamperState: s => ({ ...s, oauthReqInfo: { ...s.oauthReqInfo, redirectUri: attacker } }) });
    expect(callback.headers.get('Location') ?? '').not.toContain('attacker.example.test');
    expect(callback.status).not.toBe(302);
  });

  test('rejects a made-up or malformed access token', async () => {
    for (const token of ['not-a-real-token', 'a:b:c']) {
      expect((await call(rpc(token, 'tools/list'))).status, token).toBe(401);
    }
  });

  describe('apps identified by a client metadata document', () => {
    const doc = { client_id: CLIENT_DOC, client_name: 'Doc Client', redirect_uris: [CLIENT_CB], token_endpoint_auth_method: 'none' };
    const clientKeys = async () => (await env.OAUTH_KV.list({ prefix: 'client:' })).keys.map(k => k.name);

    test('sign in and use the tools without anything being registered', async () => {
      const before = await clientKeys();
      const { accessToken } = await signIn({ clientDoc: doc });
      expect(await clientKeys()).toEqual(before);
      const response = await call(rpc(accessToken, 'tools/list'));
      expect((await rpcResult(response)).result.tools).toHaveLength(6);
    });

    test('let a stranger go all the way to the GitHub step without writing anything', async () => {
      network({ clientDoc: doc });
      const keys = async () => (await env.OAUTH_KV.list()).keys.map(k => k.name).sort();
      const before = await keys();
      const url = new URL(`${BASE}/authorize`);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: CLIENT_DOC, redirect_uri: CLIENT_CB, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
      const page = await call(new Request(url));
      const html = await page.text();
      const field = (name: string) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))![1];
      const approved = await call(new Request(`${BASE}/authorize`, {
        method: 'POST',
        headers: { Cookie: cookieValues(page).join('; ') },
        body: new URLSearchParams({ state: field('state'), csrf_token: field('csrf_token') }),
      }));
      expect(approved.headers.get('Location')).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
      expect(await keys()).toEqual(before);
    });

    test('advertise what Claude needs to choose them: public clients and S256', async () => {
      const metadata = await (await call(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json() as any;
      expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
      expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    });

    test('show the name from the document on the approval page', async () => {
      network({ clientDoc: doc });
      const url = new URL(`${BASE}/authorize`);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: CLIENT_DOC, redirect_uri: CLIENT_CB, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
      expect(await (await call(new Request(url))).text()).toContain('Doc Client');
    });

    test.each([
      ['a return address the document does not list', doc, 'https://attacker.example.test/cb'],
      ['a document whose client_id is a different address', { ...doc, client_id: 'https://other.example.test/client.json' }, CLIENT_CB],
      ['a document that cannot be fetched', undefined, CLIENT_CB],
    ])('refuse %s', async (_case, clientDoc, redirectUri) => {
      network({ clientDoc });
      const url = new URL(`${BASE}/authorize`);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: CLIENT_DOC, redirect_uri: redirectUri, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
      const response = await call(new Request(url)).catch(e => e);
      expect(response instanceof Response ? response.status : 500).toBeGreaterThanOrEqual(400);
      expect(response instanceof Response ? response.headers.get('Location') ?? '' : '').not.toContain('attacker');
    });
  });

  describe('after the owner signs in', () => {
    let accessToken: string;
    beforeAll(async () => { accessToken = (await signIn()).accessToken!; });

    test('serves the six calendar tools over MCP', async () => {
      const response = await call(rpc(accessToken, 'tools/list'));
      expect(response.status).toBe(200);
      const { result } = await rpcResult(response);
      expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
        ['create_event', 'delete_event', 'get_event', 'list_calendars', 'list_events', 'update_event'],
      );
    });

    test('remembers the approval, sending the next visit straight to GitHub', async () => {
      const { approvedCookies, authorizeUrl } = await signIn();
      const approval = approvedCookies.filter(c => c.startsWith('__Host-APPROVED_CLIENTS='));
      const again = await call(new Request(authorizeUrl, { headers: { Cookie: approval.join('; ') } }));
      expect(again.status).toBe(302);
      expect(again.headers.get('Location')).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    });

    test('refuses the token once that account is no longer allowed', async () => {
      const response = await call(rpc(accessToken, 'tools/list'), { ALLOWED_GITHUB_LOGIN: 'someone-else' });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('Forbidden');
    });
  });
});
