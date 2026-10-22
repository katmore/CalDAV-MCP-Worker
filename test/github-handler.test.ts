import { env } from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GitHubHandler } from '../src/github-handler';
import { addApprovedClient, createOAuthState, isClientApproved } from '../src/workers-oauth-utils';

const BASE = 'https://worker.example.test';
const reqInfo = { clientId: 'client-1', redirectUri: 'https://client.example.test/cb', scope: ['read'], state: 'client-state', responseType: 'code' };

// Stands in for the OAuth provider library, which issues the tokens.
function provider(overrides: Record<string, unknown> = {}) {
  return {
    parseAuthRequest: vi.fn(async () => reqInfo),
    lookupClient: vi.fn(async () => ({ clientId: 'client-1', clientName: 'Test Client', redirectUris: [reqInfo.redirectUri] })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/cb?code=issued' })),
    ...overrides,
  };
}

const handle = (request: Request, oauth = provider(), extraEnv: Record<string, unknown> = {}) =>
  GitHubHandler.fetch(request, { ...env, OAUTH_PROVIDER: oauth, ...extraEnv } as any, {} as any);

const cookiesOf = (response: Response) => response.headers.getSetCookie();

// Fakes GitHub's token endpoint and user API. Like GitHub, each sign-in code can be
// exchanged only once, and the user API only answers for the token it issued.
function github({ login = 'owner', tokenOk = true, userOk = true } = {}) {
  const usedCodes = new Set<string>();
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === 'https://github.com/login/oauth/access_token') {
      const code = new URLSearchParams(await request.text()).get('code')!;
      const fresh = !usedCodes.has(code);
      usedCodes.add(code);
      if (!tokenOk) return new Response('denied', { status: 401 });
      return new Response(fresh ? 'access_token=gh-token' : 'error=bad_verification_code', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    }
    if (url.href === 'https://api.github.com/user') {
      const authorized = /^(token|bearer) gh-token$/i.test(request.headers.get('Authorization') ?? '');
      return authorized && userOk
        ? Response.json({ login, name: 'Owner Name', email: 'owner@example.test' })
        : Response.json({ message: 'Bad credentials' }, { status: 401 });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('GET /authorize', () => {
  test('rejects a request without a client', async () => {
    const response = await handle(new Request(`${BASE}/authorize`), provider({ parseAuthRequest: vi.fn(async () => ({ ...reqInfo, clientId: '' })) }));
    expect(response.status).toBe(400);
  });

  test('shows the approval page to a client not yet approved', async () => {
    const response = await handle(new Request(`${BASE}/authorize`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Private Calendar');
    expect(html).toContain('Test Client');
    expect(cookiesOf(response)[0]).toMatch(/^__Host-CSRF_TOKEN=/);
  });

  test('sends an already approved client straight to GitHub, bound to this browser', async () => {
    const approved = (await addApprovedClient(new Request(BASE), 'client-1', env.COOKIE_ENCRYPTION_KEY)).split(';')[0];
    const response = await handle(new Request(`${BASE}/authorize`, { headers: { Cookie: approved } }));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe(env.GITHUB_CLIENT_ID);
    expect(location.searchParams.get('scope')).toBe('read:user');
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE}/callback`);
    const [stateCookie] = cookiesOf(response);
    expect(stateCookie).toMatch(/^__Host-OAUTH_STATE=/);
    // The cookie it set is the one the callback accepts for this state.
    github();
    const state = location.searchParams.get('state')!;
    const callback = await handle(new Request(`${BASE}/callback?code=c&state=${state}`, { headers: { Cookie: stateCookie.split(';')[0] } }));
    expect(callback.status).toBe(302);
  });
});

describe('POST /authorize', () => {
  const approve = (fields: Record<string, string>, cookie = '__Host-CSRF_TOKEN=csrf-1') =>
    handle(new Request(`${BASE}/authorize`, { method: 'POST', body: new URLSearchParams(fields), headers: { Cookie: cookie } }));
  const encode = (value: unknown) => btoa(JSON.stringify(value));

  test('records the approval and sends the browser to GitHub', async () => {
    const response = await approve({ csrf_token: 'csrf-1', state: encode({ oauthReqInfo: reqInfo }) });
    expect(response.status).toBe(302);
    const state = new URL(response.headers.get('Location')!).searchParams.get('state')!;
    const [approvedCookie, stateCookie] = cookiesOf(response);
    const remembered = new Request(BASE, { headers: { Cookie: approvedCookie.split(';')[0] } });
    expect(await isClientApproved(remembered, 'client-1', env.COOKIE_ENCRYPTION_KEY)).toBe(true);
    expect(await isClientApproved(remembered, 'client-2', env.COOKIE_ENCRYPTION_KEY)).toBe(false);
    github();
    const oauth = provider();
    const callback = await handle(new Request(`${BASE}/callback?code=c&state=${state}`, { headers: { Cookie: stateCookie.split(';')[0] } }), oauth);
    expect(callback.status).toBe(302);
    expect(oauth.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({ request: reqInfo }));
  });

  test('writes nothing to storage before the GitHub sign-in succeeds', async () => {
    const keys = async () => (await env.OAUTH_KV.list()).keys.map(k => k.name).sort();
    const before = await keys();
    await approve({ csrf_token: 'csrf-1', state: encode({ oauthReqInfo: reqInfo }) });
    const approved = (await addApprovedClient(new Request(BASE), 'client-1', env.COOKIE_ENCRYPTION_KEY)).split(';')[0];
    await handle(new Request(`${BASE}/authorize`, { headers: { Cookie: approved } }));
    expect(await keys()).toEqual(before);
  });

  test('rejects a form submitted without the matching CSRF cookie', async () => {
    const response = await approve({ csrf_token: 'csrf-1', state: encode({ oauthReqInfo: reqInfo }) }, '__Host-CSRF_TOKEN=other');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  test.each([
    ['no state', {}],
    ['state that is not encoded JSON', { state: '%%%' }],
    ['state without a client', { state: encode({ oauthReqInfo: { ...reqInfo, clientId: '' } }) }],
    ['state without a request', { state: encode({}) }],
  ])('rejects %s', async (_case, fields) => {
    expect((await approve({ csrf_token: 'csrf-1', ...fields })).status).toBe(400);
  });

  test('hides unexpected failures behind a generic error', async () => {
    const response = await handle(new Request(`${BASE}/authorize`, { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } }));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal server error');
  });
});

describe('GET /callback', () => {
  async function startedFlow(info: unknown = reqInfo) {
    const { stateToken, setCookie } = await createOAuthState(info as any, env.COOKIE_ENCRYPTION_KEY);
    return new Request(`${BASE}/callback?code=gh-code&state=${stateToken}`, { headers: { Cookie: setCookie.split(';')[0] } });
  }

  test('completes sign-in for the allowed GitHub account', async () => {
    const fetchMock = github();
    const oauth = provider();
    const response = await handle(await startedFlow(), oauth);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://client.example.test/cb?code=issued');
    expect(cookiesOf(response)[0]).toMatch(/^__Host-OAUTH_STATE=;.*Max-Age=0/);
    expect(oauth.completeAuthorization).toHaveBeenCalledWith({
      metadata: { label: 'Owner Name' },
      props: { email: 'owner@example.test', login: 'owner', name: 'Owner Name' },
      request: reqInfo,
      scope: reqInfo.scope,
      userId: 'owner',
    });
    const tokenRequest = fetchMock.mock.calls.find(([input]) => String(input).includes('access_token'))!;
    expect(new URLSearchParams((tokenRequest[1] as RequestInit).body as string).get('code')).toBe('gh-code');
  });

  test('refuses any other GitHub account', async () => {
    github({ login: 'someone-else' });
    const oauth = provider();
    const response = await handle(await startedFlow(), oauth);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Not authorized');
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
  });

  test('refuses everyone when no account is allowed', async () => {
    github();
    const oauth = provider();
    expect((await handle(await startedFlow(), oauth, { ALLOWED_GITHUB_LOGIN: '' })).status).toBe(403);
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
  });

  test('stops when GitHub will not issue a token', async () => {
    github({ tokenOk: false });
    const oauth = provider();
    expect((await handle(await startedFlow(), oauth)).status).toBe(500);
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
  });

  test('rejects a callback this browser did not start', async () => {
    const fetchMock = github();
    const started = await startedFlow();
    const response = await handle(new Request(started.url));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('stops when GitHub will not say who signed in', async () => {
    github({ userOk: false });
    const oauth = provider();
    const response = await handle(await startedFlow(), oauth);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Could not verify GitHub account');
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
  });

  test("rejects a callback carrying another browser's session cookie", async () => {
    const fetchMock = github();
    const started = await startedFlow();
    const other = (await createOAuthState(reqInfo as any, env.COOKIE_ENCRYPTION_KEY)).setCookie.split(';')[0];
    const response = await handle(new Request(started.url, { headers: { Cookie: other } }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Without stored state, a replay passes the state check; GitHub refusing a reused code
  // is what stops it, as it does with the real GitHub.
  test('a replayed callback completes nothing, because the GitHub code works only once', async () => {
    github();
    const oauth = provider();
    const started = await startedFlow();
    expect((await handle(started.clone(), oauth)).status).toBe(302);
    expect((await handle(started.clone(), oauth)).status).toBe(400);
    expect(oauth.completeAuthorization).toHaveBeenCalledTimes(1);
  });

  test('rejects stored state without a client', async () => {
    github();
    expect((await handle(await startedFlow({ ...reqInfo, clientId: '' }))).status).toBe(400);
  });

  test('hides unexpected failures behind a generic error', async () => {
    const started = await startedFlow();
    const response = await handle(started, provider(), { COOKIE_ENCRYPTION_KEY: '' });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal server error');
  });
});
