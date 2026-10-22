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
- No secrets are embedded in OAuth props, and the upstream GitHub access token
  is not retained. Tool errors don't include exception details or credentials.
- Request observability is disabled.
- Cloudflare usage and account quotas determine any charges.

### Social engineering and prompt injection

These risks come from people and content rather than from flaws in the code.

- **Prompt injection:** calendar text (titles, descriptions, locations, and
  invitations from other people) reaches the assistant as-is, and may contain
  instructions aimed at it. Invitations can't be edited or deleted, and deletes
  require explicit confirmation, but other writes rely on the assistant asking
  you first.
- **Approval phishing:** only your GitHub account can complete a sign-in, but
  anyone can start one. If someone sends you a link that connects *their* app
  to your Worker and you approve it and sign in, their app gets access to your
  calendar. Only approve the connection page right after you've started
  connecting your own assistant.

## How to set it up

This takes about 20 minutes. You'll need:

- A Cloudflare account (the free plan is enough for personal use)
- A GitHub account, used only to sign in to your server
- A calendar account that supports CalDAV (see [Supported calendars](#supported-calendars))
- Git and Node.js 22 or newer on your computer

The big picture: you deploy the Worker first so you learn its address, register
that address with GitHub so it can handle sign-in, store your credentials as
Cloudflare secrets, then point your AI assistant at it. Until the secrets are
set, nobody can sign in or reach your calendar, so the early deploy is safe.

### 1. Get the code

```sh
git clone https://github.com/ackspony/CalDAV-MCP-Worker.git
cd CalDAV-MCP-Worker
npm ci
npx wrangler login
```

`wrangler` is Cloudflare's command-line tool; `login` opens your browser to
connect it to your Cloudflare account. On a machine without a browser, create
a Cloudflare API token instead and set it as `CLOUDFLARE_API_TOKEN`.

### 2. Create your local config

The committed `wrangler.jsonc` holds placeholders. Your real settings go in a
copy that Git ignores, so they never end up in the repo:

```sh
cp wrangler.jsonc wrangler.local.jsonc
```

Create the storage the Worker uses for sign-in sessions (a KV namespace):

```sh
npx wrangler kv namespace create OAUTH_KV -c wrangler.local.jsonc
```

It prints a short config snippet containing an `id`. If it offers to add the
binding to your config for you, say no; you'll add the id by hand.

Then edit `wrangler.local.jsonc`:

- `id` under `kv_namespaces`: the id printed by the command above. Leave
  `"binding": "OAUTH_KV"` as it is; the code uses that name.
- `CALDAV_URL`: your provider's address from the
  [Supported calendars](#supported-calendars) table.
- `name` (optional): the Worker's name, which becomes part of its address.
  Choose it now: renaming after the first deploy creates a second Worker and
  means updating the GitHub app in step 4.

`npm run deploy` uses this file. When you run `wrangler` directly, add
`-c wrangler.local.jsonc` so it targets your Worker. Keep a private backup of
this file, since a fresh clone won't have it.

### 3. Deploy once to get your address

```sh
npm run deploy
```

The first time, wrangler may ask you to pick a `workers.dev` subdomain for
your account. When it finishes, it prints your Worker's address near the end
of the output. It looks like
`https://<worker-name>.<your-subdomain>.workers.dev`, and you'll use it in the
next steps.

### 4. Register a GitHub OAuth app

This lets your Worker ask GitHub "who is signing in?". It gets no access to
your repositories.

In GitHub, go to your account's developer settings and create a new **OAuth
App** (not a GitHub App) with:

- **Homepage URL:** your Worker's address
- **Authorization callback URL:** your Worker's address followed by `/callback`
  (exactly, starting with `https://` and with no trailing slash)

After creating it, note the **Client ID** and generate a **client secret**.
GitHub shows the secret only once, so keep it handy for the next step.

An OAuth app has a single callback URL. If your Worker's address changes later,
edit the existing app's URLs instead of creating a new one.

### 5. Store your secrets

Have these values ready:

| Secret | What to enter |
| --- | --- |
| `GITHUB_CLIENT_ID` | The Client ID from step 4 |
| `GITHUB_CLIENT_SECRET` | The client secret from step 4 |
| `COOKIE_ENCRYPTION_KEY` | A random value (generate it below) |
| `ALLOWED_GITHUB_LOGIN` | Your GitHub username. Only this account can use the server; if it's empty, nobody can |
| `CALDAV_USERNAME` | Your calendar account's username, usually your email address (for iCloud, your Apple Account email) |
| `CALDAV_PASSWORD` | A password for this connector. Use an app-specific password if your provider offers them (most hosted providers, including iCloud, Fastmail and Yahoo, require one) |

Generate the cookie key now so you can paste it in:

```sh
openssl rand -hex 32
```

If you don't have `openssl` (for example on Windows), Node can do it:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then run each command. It prompts for the value, so the value never appears in
your shell history:

```sh
npx wrangler secret put GITHUB_CLIENT_ID -c wrangler.local.jsonc
npx wrangler secret put GITHUB_CLIENT_SECRET -c wrangler.local.jsonc
npx wrangler secret put COOKIE_ENCRYPTION_KEY -c wrangler.local.jsonc
npx wrangler secret put ALLOWED_GITHUB_LOGIN -c wrangler.local.jsonc
npx wrangler secret put CALDAV_USERNAME -c wrangler.local.jsonc
npx wrangler secret put CALDAV_PASSWORD -c wrangler.local.jsonc
```

Secrets take effect immediately; you don't need to deploy again.

### 6. Connect your AI assistant

In your assistant's settings, look for the option to add a custom connector or
remote MCP server. Enter your Worker's address followed by `/mcp`:

```
https://<worker-name>.<your-subdomain>.workers.dev/mcp
```

If it asks for an authentication type, choose OAuth. When you connect, a page
from your Worker asks you to approve the client, then GitHub asks you to sign
in. Sign in as the account you set in `ALLOWED_GITHUB_LOGIN`.

Some assistants only offer custom connectors on certain plans or behind a
developer setting; check your assistant's documentation if you don't see the
option.

### 7. Try it

Ask your assistant to list your calendars, then to show this week's events.
Compare the answer with your usual calendar app.

To test changes safely, ask it to create a test event, rename it, and delete
it, checking your calendar app after each step. Use a calendar you don't mind
experimenting in.

A few things to know before relying on it:

- Results marked `capped: true` may be missing recurring events, so don't
  treat them as proof that you're free.
- Recurring events, all-day events and invitations can't be edited (see
  [Safety rules and limits](#safety-rules-and-limits)).
- If a request times out while creating an event, have the assistant check
  whether it was created before trying again, to avoid duplicates.

### Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Not authorized" after signing in to GitHub, or "Forbidden" later | You signed in as a different account than `ALLOWED_GITHUB_LOGIN`, or that secret isn't set or was changed |
| GitHub says the redirect URI isn't valid | The callback URL in the GitHub OAuth app doesn't exactly match your Worker's address plus `/callback` |
| "CALDAV_URL must be set" | `CALDAV_URL` is empty or missing in `wrangler.local.jsonc`; fix it and deploy again |
| "CalDAV operation failed" on every request | Wrong `CALDAV_USERNAME`, `CALDAV_PASSWORD` or `CALDAV_URL` (or it's still the `caldav.example.com` placeholder), or your provider requires an app-specific password |
| `wrangler secret put` offers to create a new Worker | You changed `name` and left out `-c wrangler.local.jsonc`, so it's targeting the placeholder name |
| `wrangler secret put` offers to create a new Worker, and you did use `-c` | You skipped the deploy in step 3, so the Worker doesn't exist yet |

Sign-in errors appear in your browser; the `CALDAV_URL` and "CalDAV operation
failed" errors appear in your assistant's tool results.

To check the Worker is deployed and responding, without signing in, this
should return `401 Unauthorized`:

```sh
curl -i -X POST https://<worker-name>.<your-subdomain>.workers.dev/mcp
```

### Updating

```sh
git pull
npm ci
npm run deploy
```

If you change the code, run `npm run type-check && npm test` before deploying.
See [VALIDATION.md](VALIDATION.md) for what has been tested so far.

## License

MIT
