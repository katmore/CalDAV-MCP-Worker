import { env } from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl } from '../src/utils';
import {
  OAuthError,
  addApprovedClient,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  renderApprovalDialog,
  sanitizeText,
  sanitizeUrl,
  validateCSRFToken,
  validateOAuthState,
} from '../src/workers-oauth-utils';

const SECRET = 'test-secret';
const withCookie = (cookie?: string, url = 'https://worker.example.test/callback') =>
  new Request(url, cookie === undefined ? {} : { headers: { Cookie: cookie } });
const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
};
const reqInfo = { clientId: 'client-1', redirectUri: 'https://client.example.test/cb', scope: [], state: 's', responseType: 'code' } as any;

afterEach(() => vi.restoreAllMocks());

describe('OAuthError', () => {
  test('becomes a JSON OAuth error response with its status', async () => {
    const response = new OAuthError('invalid_request', 'Bad thing', 401).toResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'invalid_request', error_description: 'Bad thing' });
  });

  test('defaults to status 400', () => {
    expect(new OAuthError('invalid_request', 'Bad').statusCode).toBe(400);
  });
});

describe('sanitizeText', () => {
  test('escapes every HTML-significant character', () => {
    expect(sanitizeText(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#039;s&lt;/a&gt;');
  });
});

describe('sanitizeUrl', () => {
  test('keeps http and https URLs, trimmed', () => {
    expect(sanitizeUrl('  https://example.test/a  ')).toBe('https://example.test/a');
    expect(sanitizeUrl('HTTP://example.test')).toBe('HTTP://example.test');
  });

  test('rejects empty, malformed and non-web URLs', () => {
    for (const url of ['', '   ', 'not a url', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      expect(sanitizeUrl(url), url).toBe('');
    }
  });

  test('rejects URLs containing control characters', () => {
    expect(sanitizeUrl('https://example.test/\u0001')).toBe('');
    expect(sanitizeUrl('https://example.test/\u0085')).toBe('');
  });
});

describe('CSRF protection', () => {
  test('issues a random token in a locked-down cookie', () => {
    const first = generateCSRFProtection();
    expect(first.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.setCookie).toBe(`__Host-CSRF_TOKEN=${first.token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`);
    expect(generateCSRFProtection().token).not.toBe(first.token);
  });

  test('accepts a form token matching the cookie and clears the cookie', () => {
    const result = validateCSRFToken(form({ csrf_token: 'abc' }), withCookie('other=1; __Host-CSRF_TOKEN=abc'));
    expect(result.clearCookie).toContain('__Host-CSRF_TOKEN=;');
    expect(result.clearCookie).toContain('Max-Age=0');
  });

  test.each([
    ['no token in the form', form({}), withCookie('__Host-CSRF_TOKEN=abc'), 'Missing CSRF token in form data'],
    ['a file instead of a token', form({ csrf_token: new Blob(['abc']) }), withCookie('__Host-CSRF_TOKEN=abc'), 'Missing CSRF token in form data'],
    ['no cookies at all', form({ csrf_token: 'abc' }), withCookie(), 'Missing CSRF token cookie'],
    ['no CSRF cookie', form({ csrf_token: 'abc' }), withCookie('other=1'), 'Missing CSRF token cookie'],
    ['a different token', form({ csrf_token: 'abc' }), withCookie('__Host-CSRF_TOKEN=xyz'), 'CSRF token mismatch'],
  ])('rejects %s', (_case, data, request, message) => {
    expect(() => validateCSRFToken(data, request)).toThrow(message);
  });
});

describe('OAuth state', () => {
  const COOKIE = '__Host-OAUTH_STATE';
  const cookieValue = (setCookie: string) => setCookie.split(';')[0];
  const decode = (setCookie: string) => {
    const [, encoded] = cookieValue(setCookie).slice(COOKIE.length + 1).split('.');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0))));
  };
  const keys = async () => (await env.OAUTH_KV.list()).keys.map(k => k.name).sort();

  const callback = async (state: string | null, cookie?: string, secret = SECRET) => {
    const url = new URL('https://worker.example.test/callback');
    if (state) url.searchParams.set('state', state);
    return await validateOAuthState(withCookie(cookie, url.href), secret);
  };

  test('keeps the request in a signed, locked-down cookie that expires, writing nothing to storage', async () => {
    const before = await keys();
    const { stateToken, setCookie } = await createOAuthState(reqInfo, SECRET);
    expect(await keys()).toEqual(before);
    expect(setCookie).toMatch(new RegExp(`^${COOKIE}=[0-9a-f]{64}\\.[A-Za-z0-9+/=]+; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600$`));
    const payload = decode(setCookie);
    expect(payload.stateToken).toBe(stateToken);
    expect(payload.oauthReqInfo).toEqual(reqInfo);
    const secondsLeft = payload.expiresAt - Date.now() / 1000;
    expect(secondsLeft).toBeGreaterThan(0);
    expect(secondsLeft).toBeLessThanOrEqual(600);
  });

  test('accepts the state from the browser that started the sign-in, and clears the cookie', async () => {
    const { stateToken, setCookie } = await createOAuthState(reqInfo, SECRET);
    const result = await callback(stateToken, `other=1; ${cookieValue(setCookie)}`);
    expect(result.oauthReqInfo).toEqual(reqInfo);
    expect(result.clearCookie).toBe(`${COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`);
  });

  test('keeps non-ASCII request details intact', async () => {
    const unusual = { ...reqInfo, state: 'café ☕' };
    const { stateToken, setCookie } = await createOAuthState(unusual, SECRET);
    expect((await callback(stateToken, cookieValue(setCookie))).oauthReqInfo).toEqual(unusual);
  });

  test('rejects a callback without a state token', async () => {
    await expect(callback(null)).rejects.toThrow('Missing state parameter');
  });

  test('rejects state when the browser never started a sign-in', async () => {
    const { stateToken } = await createOAuthState(reqInfo, SECRET);
    await expect(callback(stateToken)).rejects.toThrow('Missing session binding cookie');
    await expect(callback(stateToken, 'other=1')).rejects.toThrow('Missing session binding cookie');
  });

  test("rejects a state token that belongs to someone else's sign-in", async () => {
    const mine = await createOAuthState(reqInfo, SECRET);
    const theirs = await createOAuthState(reqInfo, SECRET);
    await expect(callback(theirs.stateToken, cookieValue(mine.setCookie))).rejects.toThrow('does not match session');
  });

  test('rejects a cookie that was forged, edited or signed with another key', async () => {
    const { stateToken, setCookie } = await createOAuthState(reqInfo, SECRET);
    const [signature, encoded] = cookieValue(setCookie).slice(COOKIE.length + 1).split('.');
    const payload = decode(setCookie);
    const edited = btoa(JSON.stringify({ ...payload, oauthReqInfo: { ...reqInfo, redirectUri: 'https://attacker.example.test/' } }));
    for (const value of [`${signature}.${edited}`, `${'0'.repeat(64)}.${encoded}`, `${signature}`, `${signature}.${encoded}.x`, `${signature}.%%%`]) {
      await expect(callback(stateToken, `${COOKIE}=${value}`), value.slice(0, 20)).rejects.toThrow('Invalid or expired state');
    }
    await expect(callback(stateToken, cookieValue(setCookie), 'other-secret')).rejects.toThrow('Invalid or expired state');
  });

  test('rejects a sign-in that took too long', async () => {
    const { stateToken, setCookie } = await createOAuthState(reqInfo, SECRET, 600);
    vi.useFakeTimers({ now: Date.now() + 601_000 });
    try {
      await expect(callback(stateToken, cookieValue(setCookie))).rejects.toThrow('Invalid or expired state');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('approved clients cookie', () => {
  const cookieFrom = (setCookie: string) => setCookie.split(';')[0];

  test('remembers approved clients in a signed cookie', async () => {
    const setCookie = await addApprovedClient(withCookie(), 'client-1', SECRET);
    expect(setCookie).toMatch(/^__Host-APPROVED_CLIENTS=[0-9a-f]{64}\.[A-Za-z0-9+/=]+; HttpOnly; Secure; Path=\/; SameSite=Lax; Max-Age=2592000$/);
    const request = withCookie(cookieFrom(setCookie));
    expect(await isClientApproved(request, 'client-1', SECRET)).toBe(true);
    expect(await isClientApproved(request, 'client-2', SECRET)).toBe(false);
  });

  test('adds to the existing list without duplicates', async () => {
    const first = cookieFrom(await addApprovedClient(withCookie(), 'client-1', SECRET));
    const second = cookieFrom(await addApprovedClient(withCookie(first), 'client-2', SECRET));
    const third = cookieFrom(await addApprovedClient(withCookie(second), 'client-1', SECRET));
    expect(JSON.parse(atob(third.split('.')[1]))).toEqual(['client-1', 'client-2']);
  });

  test('ignores missing, malformed, forged or foreign cookies', async () => {
    const valid = cookieFrom(await addApprovedClient(withCookie(), 'client-1', SECRET));
    const [signature, payload] = valid.slice('__Host-APPROVED_CLIENTS='.length).split('.');
    const forgedPayload = btoa(JSON.stringify(['client-1', 'attacker']));
    const signed = async (value: unknown) => {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2, '0')).join('');
      return `__Host-APPROVED_CLIENTS=${sig}.${btoa(text)}`;
    };
    const cases: [string, string | undefined, string][] = [
      ['no cookie header', undefined, SECRET],
      ['no approval cookie', 'other=1', SECRET],
      ['missing signature', `__Host-APPROVED_CLIENTS=${payload}`, SECRET],
      ['extra segment', `${valid}.extra`, SECRET],
      ['empty signature', `__Host-APPROVED_CLIENTS=.${payload}`, SECRET],
      ['forged payload', `__Host-APPROVED_CLIENTS=${signature}.${forgedPayload}`, SECRET],
      ['signed with another key', valid, 'other-secret'],
      ['signed non-JSON', await signed('not json'), SECRET],
      ['signed non-array', await signed({ clientId: 'client-1' }), SECRET],
      ['signed array of non-strings', await signed(['client-1', 42]), SECRET],
    ];
    for (const [name, cookie, secret] of cases) {
      expect(await isClientApproved(withCookie(cookie), 'client-1', secret), name).toBe(false);
    }
  });

  test('refuses to sign without a secret', async () => {
    await expect(addApprovedClient(withCookie(), 'client-1', '')).rejects.toThrow('cookieSecret is required');
  });
});

describe('approval dialog', () => {
  const render = (client: any, server: any = { name: 'Server' }) =>
    renderApprovalDialog(new Request('https://worker.example.test/authorize?x=1'), {
      client, server, state: { oauthReqInfo: reqInfo }, csrfToken: 'csrf-123', setCookie: 'csrf-cookie',
    });

  test('is served with anti-framing headers and the CSRF cookie', () => {
    const response = render(null);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Set-Cookie')).toBe('csrf-cookie');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  test('posts the state and CSRF token back to the same path', async () => {
    const html = await render(null).text();
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/authorize"/);
    expect(html).toContain(`name="state" value="${btoa(JSON.stringify({ oauthReqInfo: reqInfo }))}"`);
    expect(html).toContain('name="csrf_token" value="csrf-123"');
  });

  test('names an unknown client and omits empty details', async () => {
    const html = await render(null).text();
    expect(html).toContain('Unknown MCP Client');
    for (const absent of ['<img', 'Website:', 'Privacy Policy:', 'Terms of Service:', 'Redirect URIs:', 'Contact:']) {
      expect(html).not.toContain(absent);
    }
  });

  test('shows client and server details, escaped', async () => {
    const html = await render(
      {
        clientName: '<script>alert(1)</script>',
        clientUri: 'https://client.example.test/?a="b"',
        policyUri: 'https://client.example.test/privacy',
        tosUri: 'https://client.example.test/terms',
        contacts: ['a@example.test', '<b@example.test>'],
        redirectUris: ['https://client.example.test/cb', 'javascript:alert(1)'],
      },
      { name: 'My <Server>', logo: 'https://example.test/logo.png', description: 'Desc & more' },
    ).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('https://client.example.test/?a=&quot;b&quot;');
    expect(html).toContain('https://client.example.test/privacy');
    expect(html).toContain('https://client.example.test/terms');
    expect(html).toContain('a@example.test, &lt;b@example.test&gt;');
    expect(html).toContain('https://client.example.test/cb');
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).toContain('src="https://example.test/logo.png"');
    expect(html).toContain('My &lt;Server&gt;');
    expect(html).not.toContain('My <Server>');
    expect(html).toContain('Desc &amp; more');
  });

  test('drops a logo or client links that are not web URLs', async () => {
    const html = await render(
      { clientName: 'App', clientUri: 'javascript:alert(1)', contacts: [], redirectUris: [] },
      { name: 'Server', logo: 'javascript:alert(1)' },
    ).text();
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Contact:');
    expect(html).not.toContain('Redirect URIs:');
  });
});

describe('GitHub OAuth helpers', () => {
  test('builds the GitHub authorize URL, with state only when given', () => {
    const base = { upstream_url: 'https://github.test/authorize', client_id: 'id', scope: 'read:user', redirect_uri: 'https://worker.test/callback' };
    const withState = new URL(getUpstreamAuthorizeUrl({ ...base, state: 'st' }));
    expect(Object.fromEntries(withState.searchParams)).toEqual({ client_id: 'id', redirect_uri: 'https://worker.test/callback', scope: 'read:user', state: 'st', response_type: 'code' });
    expect(new URL(getUpstreamAuthorizeUrl(base)).searchParams.has('state')).toBe(false);
  });

  const exchange = (code: string | undefined) => fetchUpstreamAuthToken({
    client_id: 'id', client_secret: 'secret', code, redirect_uri: 'https://worker.test/callback', upstream_url: 'https://github.test/token',
  });

  test('exchanges a code for an access token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('access_token=tok&scope=read%3Auser', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
    expect(await exchange('code-1')).toEqual(['tok', null]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://github.test/token');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({ client_id: 'id', client_secret: 'secret', code: 'code-1', redirect_uri: 'https://worker.test/callback' });
  });

  test('fails without contacting GitHub when there is no code', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const [token, response] = await exchange(undefined);
    expect(token).toBeNull();
    expect(response!.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fails when GitHub refuses or returns no token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 401 }));
    expect((await exchange('code-1'))[1]!.status).toBe(500);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('error=bad_verification_code', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
    expect((await exchange('code-1'))[1]!.status).toBe(400);
  });
});
