import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import worker from '../src/index';

const BASE = 'https://worker.example.test';
const CLIENT_CB = 'https://client.example.test/cb';

async function call(request: Request, overrides: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, ...overrides } as any, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const cookieValues = (response: Response) => response.headers.getSetCookie().map(c => c.split(';')[0]);

// Fakes GitHub's token endpoint and user API for the signed-in account.
function github(login: string) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === 'https://github.com/login/oauth/access_token') {
      return new Response('access_token=gh-token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    }
    if (url.href === 'https://api.github.com/user') return Response.json({ login, name: 'Owner Name', email: 'owner@example.test' });
    throw new Error(`unexpected fetch ${url.href}`);
  });
}

// Runs the whole sign-in as an MCP client would: register, approve, GitHub, token.
async function signIn(login = 'owner') {
  const registered = await call(new Request(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [CLIENT_CB], token_endpoint_auth_method: 'none' }),
  }));
  expect(registered.status).toBe(201);
  const { client_id } = await registered.json() as { client_id: string };

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

  const approved = await call(new Request(`${BASE}/authorize`, {
    method: 'POST',
    headers: { Cookie: cookieValues(page).join('; ') },
    body: new URLSearchParams({ state: field('state'), csrf_token: field('csrf_token') }),
  }));
  expect(approved.status).toBe(302);
  const state = new URL(approved.headers.get('Location')!).searchParams.get('state')!;

  github(login);
  const callback = await call(new Request(`${BASE}/callback?code=gh-code&state=${state}`, { headers: { Cookie: cookieValues(approved).join('; ') } }));
  vi.restoreAllMocks();
  if (callback.status !== 302) return { callback };
  const redirect = new URL(callback.headers.get('Location')!);
  expect(redirect.origin + redirect.pathname).toBe(CLIENT_CB);
  expect(redirect.searchParams.get('state')).toBe('client-state');

  const token = await call(new Request(`${BASE}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, redirect_uri: CLIENT_CB, client_id, code_verifier: verifier }),
  }));
  expect(token.status).toBe(200);
  const { access_token } = await token.json() as { access_token: string };
  return { callback, accessToken: access_token };
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

  test('does not let another GitHub account finish signing in', async () => {
    const { callback } = await signIn('someone-else');
    expect(callback.status).toBe(403);
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

    test('refuses the token once that account is no longer allowed', async () => {
      const response = await call(rpc(accessToken, 'tools/list'), { ALLOWED_GITHUB_LOGIN: 'someone-else' });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('Forbidden');
    });
  });
});
