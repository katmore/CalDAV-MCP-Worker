interface Env { CALDAV_USERNAME: string; CALDAV_PASSWORD: string; ALLOWED_GITHUB_LOGIN: string; CALDAV_URL: string; CALDAV_TRUSTED_HOSTS?: string; GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string; COOKIE_ENCRYPTION_KEY: string; OAUTH_KV: KVNamespace; }

declare namespace Cloudflare { interface Env { GITHUB_CLIENT_ID: string; COOKIE_ENCRYPTION_KEY: string; } }
