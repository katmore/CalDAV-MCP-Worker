# CalDAV MCP Worker

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![MCP](https://img.shields.io/badge/MCP-server-6E56CF)](https://modelcontextprotocol.io)
[![CalDAV](https://img.shields.io/badge/CalDAV-RFC%204791-555555)](https://www.rfc-editor.org/rfc/rfc4791)

Let an AI assistant such as ChatGPT or Claude read and manage your calendar.
You deploy this small server to your own Cloudflare account and connect your
assistant to it; from then on you can ask things like "what's on my calendar
Thursday?" or "move my 3pm to 4pm". It works with Apple iCloud calendars and
other [CalDAV](#caldav) providers. Your calendar stays with your provider,
nothing runs on your computer, and only you can sign in.

## Supported calendars

Any CalDAV server that accepts a username and password at an `https://`
address should work; plain `http://` servers are not supported. Set
`CALDAV_URL` to your provider's address.

Your username and password are only ever sent over https, and only to the
`CALDAV_URL` host and any hosts you list in `CALDAV_TRUSTED_HOSTS`. Some
providers hand you on to another server after the first request; iCloud does
(to a server such as `p42-caldav.icloud.com`), so it needs `.icloud.com` there.
A leading dot trusts that domain and everything under it.

| Provider | `CALDAV_URL` | `CALDAV_TRUSTED_HOSTS` | Password to use |
| --- | --- | --- | --- |
| Apple iCloud | `https://caldav.icloud.com` | `.icloud.com` | [App-specific password](#app-specific-password) from account.apple.com |
| Fastmail | `https://caldav.fastmail.com` | none | App password from Fastmail settings |
| Yahoo Calendar | `https://caldav.calendar.yahoo.com` | none | App password from Yahoo account security |
| Nextcloud | `https://<your-server>/remote.php/dav` | none | App password from Nextcloud security settings |
| Radicale, Baïkal and other self-hosted servers | Your server's CalDAV URL | none | Your account password |

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
  the whole series, so the assistant has to ask for whole-series deletion
  explicitly; single occurrences can't be changed or removed on their own.
- **Repeating events may be incomplete.** Listings that might be missing
  occurrences of a repeating event, or that include events whose timezone isn't
  saved with them, come back flagged `capped: true` so the assistant knows not to treat
  them as a free/busy answer. Double-check repeating events against your
  calendar app.

**Approving changes is up to your assistant.** The server marks
`update_event` and `delete_event` as destructive so that assistants know to ask
you before using them, but it can't see whether you said yes. `delete_event`
also requires `confirm: "DELETE"`: a deliberate cue to the assistant that
deleting is serious, not proof that you approved, since the assistant fills it
in itself.

### Security notes

- Your calendar password usually unlocks more than these six tools use: often
  every calendar on the account, and sometimes contacts. That's why a dedicated
  app-specific password is recommended; you can revoke it at any time without
  changing your main password.
- Your calendar username and password are only sent over https, to the
  `CALDAV_URL` host and the hosts in `CALDAV_TRUSTED_HOSTS`. Every request is
  checked, including addresses the calendar server hands back and each step of
  a redirect.
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
git clone https://github.com/katmore/CalDAV-MCP-Worker.git
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
- `CALDAV_URL` and, if your provider needs it, `CALDAV_TRUSTED_HOSTS`: from the
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

Paste these into your assistant in order, and again after each deploy. Stop at
the first failure, compare each answer with your calendar app, and use a
calendar you don't mind testing in.

1. List your calendars. They should match your calendar app.

   ```
   Using the calendar connector, list all of my calendars.
   ```

2. Read this week. Check the times, especially repeating events. A `capped`
   result is normal when a repeating event runs past the end of the week.

   ```
   Show me the events on my <calendar name> calendar for this week.
   ```

3. Create a test event. If the request times out, have the assistant list that
   day's events before trying again, to avoid a duplicate.

   ```
   Create an event called "Connector test" on my <calendar name> calendar, <day> from <start time> to <end time>. Then read it back and show me what was saved.
   ```

4. Change it. If this fails, the event may have changed since it was read; ask
   the assistant to read it again and retry.

   ```
   Rename the "Connector test" event to "Connector test (edited)" and move it 30 minutes later. Then read it back.
   ```

5. Delete it. Nothing else on that day should change.

   ```
   Delete the "Connector test (edited)" event, then list that day's events to confirm it's gone.
   ```

6. Optionally, check the safety rules. Both should fail and leave your calendar
   unchanged (see [Safety rules and limits](#safety-rules-and-limits)).

   ```
   Change the title of my repeating <event name> event.
   ```

   ```
   Change the time of the <event name> invitation.
   ```

### Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Not authorized" after signing in to GitHub, or "Forbidden" later | You signed in as a different account than `ALLOWED_GITHUB_LOGIN`, or that secret isn't set or was changed |
| GitHub says the redirect URI isn't valid | The callback URL in the GitHub OAuth app doesn't exactly match your Worker's address plus `/callback` |
| "CALDAV_URL must be set" or "must be an https:// address" | `CALDAV_URL` in `wrangler.local.jsonc` is missing, empty or not `https://`; fix it and deploy again |
| "CalDAV operation failed" with reason `TransportError` | The calendar server sent the Worker to an `http://` address or to a host not in `CALDAV_TRUSTED_HOSTS`. For iCloud, set `CALDAV_TRUSTED_HOSTS` to `.icloud.com` |
| "CALDAV_TRUSTED_HOSTS must list host names" | Use bare host names separated by commas, such as `.icloud.com`, with no `https://` or paths |
| "CalDAV operation failed" on every request | Wrong `CALDAV_USERNAME`, `CALDAV_PASSWORD` or `CALDAV_URL` (or it's still the `caldav.example.com` placeholder), or your provider requires an app-specific password |
| `wrangler secret put` offers to create a new Worker | You changed `name` and left out `-c wrangler.local.jsonc`, so it's targeting the placeholder name |
| `wrangler secret put` offers to create a new Worker, and you did use `-c` | You skipped the deploy in step 3, so the Worker doesn't exist yet |

Sign-in errors appear in your browser; the `CALDAV_URL`, `CALDAV_TRUSTED_HOSTS`
and "CalDAV operation failed" errors appear in your assistant's replies.

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
The tests run in Cloudflare's runtime and fail if any code in `src/` is
untested or if the copied Cloudflare sign-in code changes without a recorded
patch. [VALIDATION.md](VALIDATION.md) explains what is tested and how.

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
