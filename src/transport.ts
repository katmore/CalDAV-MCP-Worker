// The network boundary for CalDAV. Every request the CalDAV client makes, including
// service discovery and addresses taken from server responses, goes through guardedFetch:
// it must use https, and it may only go to a trusted host, since each request carries the
// CalDAV credentials. Redirects are followed here, one checked hop at a time, rather than
// by the runtime, where intermediate hops could not be inspected.

// Messages are fixed text written for the owner, so they are safe to show in tool errors.
export class ConfigurationError extends Error {}

export class TransportError extends Error {
  name = 'TransportError';
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HOST_ENTRY = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/;

// Returns the CALDAV_URL as a URL, refusing anything but https.
export function caldavUrl(setting: string | undefined): URL {
  const value = setting?.trim();
  if (!value) throw new ConfigurationError('CALDAV_URL must be set in Worker configuration');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError('CALDAV_URL must be an https:// address');
  }
  if (url.protocol !== 'https:') throw new ConfigurationError('CALDAV_URL must be an https:// address');
  return url;
}

// Credentials go to the CALDAV_URL host, plus any CALDAV_TRUSTED_HOSTS entries: an exact
// host name, or a name starting with "." to trust that domain and everything under it.
export function trustedHosts(configured: URL, setting: string | undefined): (host: string) => boolean {
  const entries = (setting ?? '').split(/[\s,]+/).map(e => e.toLowerCase()).filter(Boolean);
  if (entries.some(e => !HOST_ENTRY.test(e))) {
    throw new ConfigurationError('CALDAV_TRUSTED_HOSTS must list host names, such as .icloud.com');
  }
  return host => {
    host = host.toLowerCase();
    return host === configured.hostname
      || entries.some(e => e.startsWith('.') ? host === e.slice(1) || host.endsWith(e) : host === e);
  };
}

export function guardedFetch(isTrusted: (host: string) => boolean, send: (request: Request) => Promise<Response> = request => fetch(request)) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const original = new Request(input, init);
    const headers = new Headers(original.headers);
    let method = original.method;
    let body = method === 'GET' || method === 'HEAD' ? undefined : await original.arrayBuffer();
    let url = new URL(original.url);
    for (let hops = 0; ; hops++) {
      if (url.protocol !== 'https:') throw new TransportError('CalDAV requests must use https');
      if (url.username || url.password || !isTrusted(url.hostname)) throw new TransportError('CalDAV host is not trusted');
      const response = await send(new Request(url, { method, headers, body, redirect: 'manual' }));
      // The caller reads redirects itself (as discovery does); its next request comes back through here.
      if (original.redirect === 'manual' || !REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('Location');
      if (!location) return response;
      if (hops >= MAX_REDIRECTS) throw new TransportError('Too many CalDAV redirects');
      url = new URL(location, url);
      if (response.status === 303 && method !== 'HEAD') {
        method = 'GET';
        body = undefined;
        headers.delete('Content-Type');
      }
    }
  };
}
