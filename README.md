# CalDAV MCP Worker

Let an AI assistant such as ChatGPT or Claude read and manage your calendar.
You deploy this small server to your own Cloudflare account and connect your
assistant to it; from then on you can ask things like "what's on my calendar
Thursday?" or "move my 3pm to 4pm". It works with Apple iCloud calendars and
other [CalDAV](#caldav) providers. Your calendar stays with your provider,
nothing runs on your computer, and only you can sign in.

## Supported calendars

Any CalDAV server that accepts a username and password at an `https://`
address should work; plain `http://` servers are not supported. Set
`CALDAV_URL` to your provider's address:

| Provider | `CALDAV_URL` | Password to use |
| --- | --- | --- |
| Apple iCloud | `https://caldav.icloud.com` | [App-specific password](#app-specific-password) from account.apple.com |
| Fastmail | `https://caldav.fastmail.com` | App password from Fastmail settings |
| Yahoo Calendar | `https://caldav.calendar.yahoo.com` | App password from Yahoo account security |
| Nextcloud | `https://<your-server>/remote.php/dav` | App password from Nextcloud security settings |
| Radicale, Baïkal and other self-hosted servers | Your server's CalDAV URL | Your account password |

iCloud has been tested end to end (see [VALIDATION.md](VALIDATION.md)); the
others should work but are untested. Google Calendar is not supported: it only
allows calendar access through its own sign-in system, not with a password.

## How it works

The server is a [Cloudflare Worker](#cloudflare-worker) that sits between your
AI assistant and your calendar provider. Your assistant talks to it using
[MCP](#mcp), and it talks to your calendar using CalDAV:

```
AI assistant ──MCP──▶ your Worker ──CalDAV──▶ your calendar provider
                          │
                          └── GitHub: checks it's you signing in
```

- **Sign-in.** The Worker uses [OAuth](#oauth) with your GitHub account to
  confirm it's you. It only reads your public GitHub profile (username, name and
  email); it gets no access to your repositories. Your username is checked
  when you sign in and again on every request.
- **Calendar access.** The Worker logs in to your calendar provider with a
  username and password stored as [secrets](#secret).
- **Storage.** The only thing the Worker stores is sign-in records, kept in a
  [KV namespace](#kv-namespace).

### Tools

| Tool | What it does |
| --- | --- |
| `list_calendars` | List the calendars on the connected CalDAV account |
| `list_events` | List events in one calendar over a date range (max 90 days) |
| `get_event` | Read one event with all its details |
| `create_event` | Create a one-off (non-repeating) event with a start and end time |
| `update_event` | Change the title, times, location or description of a one-off event |
| `delete_event` | Delete an event |

### Safety rules and limits

These are enforced by the server itself, whatever the assistant asks for.

- **Only your real calendars.** Every request is checked against the calendars
  on your account at that moment, so the assistant can't act on a calendar or
  event that doesn't exist.
- **No silent overwrites.** Before changing or deleting an event, the assistant
  must read it first. If the event changed in the meantime (say, you edited it
  on your phone), the change is refused instead of overwriting yours. Creating
  an event never replaces an existing one.
- **What can't be edited:** repeating events, all-day events and invitations.
  Events defined by a duration rather than an end time can't have their times
  changed. When you edit an event, details the server doesn't handle (such as
  alarms) are left untouched.
- **What can't be deleted:** invitations. Deleting a repeating event removes
  the whole series, so the assistant has to confirm that explicitly; single
  occurrences can't be changed or removed on their own.
- **Repeating events may be incomplete.** Listings that might be missing
  occurrences of a repeating event, or that include events saved without a
  timezone, come back flagged `capped: true` so the assistant knows not to treat
  them as a free/busy answer. Double-check repeating events against your
  calendar app.

### Security notes

- Your calendar password usually unlocks more than these six tools use: often
  every calendar on the account, and sometimes contacts. That's why a dedicated
  app-specific password is recommended; you can revoke it at any time without
  changing your main password.
- The Worker doesn't keep your GitHub sign-in token, and its error messages
  never include passwords or internal details.
- Cloudflare's request logging is turned off for the Worker, so your calendar
  requests aren't logged there.

### Social engineering and prompt injection

- **Prompt injection:** calendar text (titles, descriptions, locations, and
  invitations from other people) reaches the assistant as-is, and may contain
  instructions aimed at it. Invitations can't be edited or deleted; every other
  write relies on the assistant asking you first.
- **Approval phishing:** only your GitHub account can complete a sign-in, but
  anyone can start one. If someone sends you a link that connects *their* app
  to your Worker and you approve it and sign in, their app gets access to your
  calendar. Only approve the connection page right after you've started
  connecting your own assistant.

## Setup

### Prerequisites

This guide assumes you're comfortable running commands in a terminal, cloning
a Git repository and editing a config file. No prior experience with
Cloudflare, OAuth or MCP is needed; the [glossary](#glossary) covers the terms
that come up.

You'll need:

- A Cloudflare account (the free plan is enough for personal use)
- A GitHub account, used only to sign in to your server
- A calendar account that supports CalDAV (see [Supported calendars](#supported-calendars))
- Git and Node.js 22 or newer installed on your computer
- An AI assistant that can connect to remote MCP servers

### 1. Get the code

```sh
git clone https://github.com/ackspony/CalDAV-MCP-Worker.git
cd CalDAV-MCP-Worker
npm ci
npx wrangler login
```

[`wrangler`](#wrangler) is Cloudflare's command-line tool; `login` opens your
browser to connect it to your Cloudflare account.

### 2. Create your local config

The committed `wrangler.jsonc` holds placeholders. Your real settings go in a
copy that Git ignores, so they never end up in the repo:

```sh
cp wrangler.jsonc wrangler.local.jsonc
```

Create the storage the Worker uses for sign-in records:

```sh
npx wrangler kv namespace create OAUTH_KV -c wrangler.local.jsonc
```

It prints a short config snippet containing an `id`. If it offers to update
your config file for you, say no; you'll add the id by hand.

Then edit `wrangler.local.jsonc`:

- `id` under `kv_namespaces`: the id printed by the command above. Leave
  `"binding": "OAUTH_KV"` as it is; the code uses that name.
- `CALDAV_URL`: your provider's address from the
  [Supported calendars](#supported-calendars) table.
- `name` (optional): the Worker's name, which becomes part of its address.
  Choose it now: renaming after the first deploy creates a second Worker and
  means updating the GitHub app in step 4.

`npm run deploy` uses this file. When you run `wrangler` directly, add
`-c wrangler.local.jsonc` so it targets your Worker.

### 3. Deploy once to get your address

```sh
npm run deploy
```

The first time, wrangler may ask you to choose a name for your account's
`workers.dev` addresses (your subdomain). When it finishes, it prints your
Worker's address near the end of the output. It looks like
`https://<worker-name>.<your-subdomain>.workers.dev`, and you'll use it in the
next steps.

Deploying before the secrets are set is safe: until they are, nobody can sign
in or reach your calendar.

### 4. Register a GitHub OAuth app

In GitHub, go to your account's developer settings and create a new
[**OAuth App**](#oauth) (not a GitHub App) with:

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
| `CALDAV_PASSWORD` | The password the Worker will log in with. Use an app-specific password if your provider offers one |

Generate the `COOKIE_ENCRYPTION_KEY` value now so you can paste it in:

```sh
openssl rand -hex 32
```

If you don't have `openssl` (for example on Windows), Node can do it:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then run these. Each one prompts for its value, so nothing lands in your shell
history:

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
remote [MCP](#mcp) server. Enter your Worker's address followed by `/mcp`:

```
https://<worker-name>.<your-subdomain>.workers.dev/mcp
```

If it asks for an authentication type, choose OAuth. When you connect, a page
from your Worker asks you to approve the connection, then GitHub asks you to
sign in. Sign in as the account you set in `ALLOWED_GITHUB_LOGIN`.

Some assistants only offer custom connectors on certain plans or behind a
developer setting; check your assistant's documentation if you don't see the
option.

### 7. Try it

Ask your assistant to list your calendars, then to show this week's events.
Compare the answer with your usual calendar app.

To test changes safely, ask it to create a test event, rename it, and delete
it, checking your calendar app after each step. Use a calendar you don't mind
experimenting in.

If a request times out while creating an event, have the assistant check
whether it was created before trying again, to avoid duplicates. See
[Safety rules and limits](#safety-rules-and-limits) for what it can't do.

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
failed" errors appear in your assistant's replies.

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

## Glossary

### CalDAV

The standard way calendar apps read and write calendars on a server. iCloud,
Fastmail, Nextcloud and many others support it, which is why one Worker works
with all of them.

### MCP

Model Context Protocol: the standard way AI assistants connect to outside
tools. Your assistant sees this Worker as a set of calendar tools it can call.
See [modelcontextprotocol.io](https://modelcontextprotocol.io).

### Cloudflare Worker

A small program that runs on Cloudflare's servers instead of your computer.
It's always on and gets its own `https://` address.

### wrangler

Cloudflare's command-line tool for deploying Workers and managing their
settings. `npm ci` installs it with the project, and you run it with
`npx wrangler`.

### OAuth

The "sign in with…" system used across the web. Here it's used twice: your
assistant signs in to your Worker, and your Worker asks GitHub to confirm who
you are. An OAuth app is the registration on GitHub that allows this.

### Secret

A setting stored encrypted in Cloudflare, such as a password. The Worker can
read it, but it never appears in your code or config files, and its value
isn't shown again after you set it.

### KV namespace

A small key-value store in Cloudflare, like a simple database. The Worker uses
one to keep track of sign-ins.

### App-specific password

A separate password your calendar provider generates for one app. It works
instead of your main password, and you can revoke it on its own at any time.
Most hosted providers require one for CalDAV.

## Legal

Copyright (c) 2026 D B.
Portions copyright (c) 2025 Cloudflare, Inc., adapted from the Cloudflare
starter.

Released under the terms of the MIT License. See [LICENSE](LICENSE) for the
full text.
