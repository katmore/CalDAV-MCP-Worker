# CalDAV MCP Worker

Let an AI assistant such as ChatGPT or Claude read and manage your calendar.
You deploy this small server to your own Cloudflare account and connect your
assistant to it; from then on you can ask things like "what's on my calendar
Thursday?" or "move my 3pm to 4pm". It works with Apple iCloud calendars and
other CalDAV providers. Your calendar stays with your provider, nothing runs on
your computer, and only you can sign in.

## Supported calendars

Any CalDAV server that accepts a username and password (HTTP Basic auth) over
HTTPS should work; plain `http://` servers are not supported. Set `CALDAV_URL`
to your provider's address:

| Provider | `CALDAV_URL` | Password to use |
| --- | --- | --- |
| Apple iCloud | `https://caldav.icloud.com` | App-specific password from account.apple.com |
| Fastmail | `https://caldav.fastmail.com` | App password from Fastmail settings |
| Yahoo Calendar | `https://caldav.calendar.yahoo.com` | App password from Yahoo account security |
| Nextcloud | `https://<your-server>/remote.php/dav` | App password from Nextcloud security settings |
| Radicale, Baïkal and other self-hosted servers | Your server's CalDAV URL | Your account password |

iCloud has been tested end to end (see [VALIDATION.md](VALIDATION.md)); the
others should work but are untested. Google Calendar is not supported, because
its CalDAV endpoint requires OAuth rather than a password.

## How it works

The server is a single-owner Cloudflare Worker that exposes a CalDAV calendar as an
OAuth-protected remote [MCP](https://modelcontextprotocol.io) server:

```
MCP client ──OAuth──▶ Cloudflare Worker ──CalDAV (username + password)──▶ CalDAV server
                         │
                         └─ GitHub OAuth: signs in the one allowed owner
```

- **Sign-in.** GitHub is used only to identify the owner; no GitHub calendar or
  repository permissions are requested. The allowed login is checked when the
  OAuth token is issued and again before any tool is registered.
- **Calendar access.** The Worker talks to your provider over CalDAV using a
  username and password stored as Worker secrets. Use an app-specific password
  if your provider offers one.
- **Runtime.** Based on the official Cloudflare GitHub OAuth MCP starter, with a
  stateless MCP SDK v2 handler (not the deprecated McpAgent transport). OAuth
  state lives in one KV namespace; there are no AI or Durable Object bindings.

### Tools

| Tool | What it does |
| --- | --- |
| `list_calendars` | List the calendars on the connected CalDAV account |
| `list_events` | List events in one calendar over a date range (max 90 days) |
| `get_event` | Read one full iCalendar resource |
| `create_event` | Create a timed, nonrecurring event |
| `update_event` | Change the title, times, location or description of a nonrecurring event |
| `delete_event` | Delete an event resource (requires explicit confirmation) |

### Safety rules and limits

- Calendar and resource IDs must belong to a calendar freshly discovered from
  the connected CalDAV account.
- Writes check the HTTP status. Updates and deletes require the ETag returned by
  a prior read and use DAV conditional writes; new resources use If-None-Match.
- Updates preserve unknown iCalendar properties, and refuse recurrence
  (including RDATE), all-day events, invitations and duration-based time edits.
- Deletion refuses invitations, and deleting a recurring resource requires
  explicit whole-series confirmation. Individual occurrences cannot be edited.
- Reads register embedded VTIMEZONE data and skip cancelled occurrences.
  Recurrence expansion has limits and marks possibly incomplete results with
  `capped: true`; never infer availability from such a result. Floating times
  need manual timezone interpretation. This is not a complete recurrence or
  scheduling engine; verify against your provider's real data before relying on recurring
  results.

### Security notes

- The CalDAV credentials usually grant broader access than these six tools
  (often the whole account's calendars, and sometimes contacts).
- The `/register` and `/authorize` endpoints are public, so anyone can register
  an MCP client and start a login; the GitHub allowlist is the only access
  control. Before clicking Approve, check the client name and redirect URIs,
  and never approve a link you didn't start.
- No secrets are embedded in OAuth props, and the upstream GitHub access token
  is not retained. Tool errors don't include exception details or credentials.
- Request observability is disabled.
- Cloudflare usage and account quotas determine any charges.

## How to set it up

You need a Cloudflare account, a GitHub account, a CalDAV calendar account,
and Node.js 22+.

1. Install dependencies and sign in to Cloudflare:

   ```sh
   npm ci
   npx wrangler login
   ```

2. Create the KV namespace and note its id:

   ```sh
   npx wrangler kv namespace create OAUTH_KV
   ```

3. Copy `wrangler.jsonc` to `wrangler.local.jsonc` (gitignored) and fill in the
   KV namespace id and, optionally, the Worker name. The `deploy`, `dev` and
   `start` npm scripts use this file.

   Set `CALDAV_URL` to your provider's CalDAV address (the example value is a
   placeholder). There is no fallback, and calendar requests are rejected if it
   is missing.

4. Find your workers.dev subdomain in the Cloudflare Workers dashboard, then
   create a GitHub OAuth App at https://github.com/settings/developers:
   - Homepage: `https://<worker-name>.<your-subdomain>.workers.dev`
   - Callback: `https://<worker-name>.<your-subdomain>.workers.dev/callback`

5. Create a password for this connector at your calendar provider. If it
   offers app-specific passwords, create one dedicated to this connector.

6. Set the secrets from your own terminal (or the Cloudflare dashboard). Each
   command prompts for its value:

   ```sh
   npx wrangler secret put GITHUB_CLIENT_ID -c wrangler.local.jsonc
   npx wrangler secret put GITHUB_CLIENT_SECRET -c wrangler.local.jsonc
   npx wrangler secret put COOKIE_ENCRYPTION_KEY -c wrangler.local.jsonc
   npx wrangler secret put ALLOWED_GITHUB_LOGIN -c wrangler.local.jsonc
   npx wrangler secret put CALDAV_USERNAME -c wrangler.local.jsonc
   npx wrangler secret put CALDAV_PASSWORD -c wrangler.local.jsonc
   ```

   - `ALLOWED_GITHUB_LOGIN`: the one GitHub login allowed to use the tools. If
     it is empty or unset, all access is denied.
   - `COOKIE_ENCRYPTION_KEY`: a random 32-byte hex value, e.g.
     `openssl rand -hex 32`.

   Never put secrets in source files, command arguments or Git. `.dev.vars*`
   and `.env*` are gitignored.

7. Check, then deploy:

   ```sh
   npm run type-check && npm test
   npx wrangler deploy --dry-run -c wrangler.local.jsonc
   npm run deploy
   ```

8. In your MCP client, add a remote MCP server at
   `https://<worker-name>.<your-subdomain>.workers.dev/mcp` using OAuth, and
   authorize as the allowlisted GitHub user.

### Check it before relying on it

- An unauthenticated MCP initialize request must return 401.
- Complete a real OAuth login from your client; a different GitHub account
  must be refused.
- List calendars and compare a narrow event range with your calendar app,
  including DST changes and recurrence exceptions. Treat calendar text as
  untrusted data.
- In a writable calendar, create a disposable event, read it back, update its
  title, read it again, then delete only that event using its latest ETag and
  confirm it is gone. A timeout is ambiguous: read before retrying a creation
  to avoid duplicates.

See [VALIDATION.md](VALIDATION.md) for what has been verified so far.

## License

MIT
