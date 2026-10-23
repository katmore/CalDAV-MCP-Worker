# Validation

How this project is checked: automated tests that run on every change, a check
on the code copied from Cloudflare, and a manual test against a live calendar.

## Automated tests

```sh
npm test
```

This runs about 150 tests inside workerd, the same runtime Cloudflare uses for
the deployed Worker, using Vitest and Cloudflare's Vitest plugin. It fails if:

- any test fails,
- any line, statement, function or branch in `src/` is not exercised by a test,
- or the code copied from Cloudflare has changed without a recorded patch (see
  [Copied starter code](#copied-starter-code)).

The same command runs on GitHub for every push and pull request
(`.github/workflows/tests.yml`); the README's tests badge shows the latest
result on `main`. Because the run fails below 100% coverage, the coverage badge
holds whenever the tests badge is green.

Nothing in the tests reaches a real account. The calendar server and GitHub are
replaced by fakes, and every secret has a test-only value in
`vitest.config.mts`.

### What the tests check

| File | Covers |
| --- | --- |
| `test/checks.test.ts` | The owner check; the calendar boundary, one test per rule (other hosts, ports, `http`, credentials, query strings, fragments, `..` and encoded slashes, nested folders, non-`.ics` files, look-alike sibling folders); refused saves never counting as success; what counts as a repeating event; timezones staying inside the event that defines them |
| `test/calendar.test.ts` | All six calendar tools against a fake calendar server: what is written and where, the version sent with each change, refused saves, edits keeping alarms and unknown fields, creating timed, all-day and repeating events (including the timezone definition, checked in five zones with different daylight-saving rules), editing one-off events, all-day events and events stored with a duration, changing one occurrence, this and following, or a whole series (including cancelled dates and edited occurrences moving with a series, and the new half of a split being removed again if the old half can't be shortened), the confirmations for deletes, whole-series deletes and events with guests, the `capped` flag, the 90-day, 250-event and 500-occurrence limits, input validation, the read-only and destructive markers on each tool, and error messages: the server's own explanations (such as which confirmation to add) reach the assistant, while internal errors are reduced to their type |
| `test/oauth-utils.test.ts` | Sign-in building blocks: CSRF tokens, sign-in state kept in a signed, expiring cookie tied to the browser that started it (forged, edited, expired and mismatched cookies are refused, and nothing is written to KV), the signed "approved apps" cookie (including forged and foreign cookies), HTML escaping and link filtering on the approval page, and the GitHub token exchange |
| `test/github-handler.test.ts` | The sign-in pages: approval, the GitHub callback, refusing any GitHub account but the owner, failed GitHub responses, replayed or cross-browser callbacks, and hidden internal errors |
| `test/transport.test.ts` | The CalDAV network boundary, using the real CalDAV client against a fake network: `CALDAV_URL` must be https; discovery, server-listed addresses and every redirect step stay on https and on trusted hosts; the network is never left to follow redirects unchecked; refusals are reported without addresses or credentials; create, update and delete still send their version checks |
| `test/index.test.ts` | The whole sign-in end to end, as an MCP client does it: register (or identify with a client metadata document, which leaves nothing stored), approve, sign in through a fake GitHub, exchange the code with PKCE, then list the calendar tools. Metadata documents with an unlisted return address, a mismatched `client_id` or that can't be fetched are refused. Registration is off by default (not advertised, `/register` refused, nothing stored), can be turned on with `ALLOW_CLIENT_REGISTRATION`, and apps registered earlier keep working after it's turned off. Also: tokens that are missing, made up or belong to an account no longer allowed; a tampered redirect address; remembered approvals |

### How the fakes work

- **Calendar server:** a small stand-in for the CalDAV client that serves
  fixed events and records every write: which event, which version it was sent
  with, and the exact calendar data. It can also refuse writes or answer with
  the wrong event, so the tests can check those cases are caught.
- **GitHub:** the token exchange and "who signed in" lookups are faked. Like
  the real GitHub, the fake only answers for the token it issued.
- **Tool calls** go through each tool's input rules first, as the MCP layer
  does, so validation and defaults are tested too.

### Checking the tests themselves

Full coverage only shows that code ran. To check the tests would notice a
rule breaking, each rule was broken on purpose and a test had to fail. Each of these breakages was caught:

- saves refused by the server reported as success (create, update, delete)
- calendar boundary rules removed (fragments, non-`.ics` files, credentials, backslashes)
- invitations with only attendees allowed to be edited or deleted
- an edit sent without the event's version, dropping the new title, or not
  increasing the event's sequence number
- events with excluded dates no longer treated as repeating
- an edited occurrence changing the whole series, or a second copy added for an
  occurrence that already had one
- a split series keeping cancelled dates or edited occurrences on the wrong
  side, or a counted series not divided between the two halves
- the new half of a split series left behind when the old half can't be shortened
- a moved time keeping the old timezone on a UTC value
- moving a series leaving its cancelled dates, extra dates or edited occurrences behind
- a cancelled occurrence keeping its edited copy
- a series edit dropping the series' timezone
- a generated timezone missing its later daylight-saving changes, or labelling
  summer and winter time the wrong way round
- the confirmation for events with guests removed
- event lists no longer sorted
- error messages revealing internal details
- one event's timezone affecting others
- the owner check skipped at sign-in or on each request
- GitHub asked who signed in without the token
- the sign-in state cookie accepted without its signature, after it expired,
  without matching the state token, or when missing; or not cleared afterwards
- the approval step writing to KV again
- the CSRF check skipped
- the weaker "plain" PKCE allowed

### Bugs the tests found

Writing these tests, and an outside review, found and fixed:

- **Credentials could be sent over http or to other hosts.** The CalDAV client
  would send the username and password to an `http://` `CALDAV_URL`, to an
  `http://` address returned by the server's discovery step, and to any host
  the server pointed it at. Every CalDAV request now goes through a guarded
  network function that requires https and a trusted host
  (`CALDAV_TRUSTED_HOSTS`), and follows redirects itself so each step is
  checked. The regression tests failed against the old behaviour before the
  fix.
- **Timezones leaking between events.** Each event's timezone definitions were
  registered globally, so an event (for example an invitation) could redefine
  a zone such as `Europe/Paris` and shift the times of other events that use
  it. Each event's timezones now apply only to that event.
- **`list_events` failing or losing its warning.** One event holding only
  moved occurrences made the whole list fail, and the `capped` flag could be
  switched back off by a later event.
- **An unhandled error during sign-in.** A failed GitHub lookup left an
  unhandled error inside the Octokit library. The lookup is now a plain
  request, with a clear error when GitHub won't confirm the account.

## Copied starter code

The sign-in code in `src/github-handler.ts`, `src/utils.ts` and
`src/workers-oauth-utils.ts` comes from Cloudflare's MIT-licensed
[remote MCP GitHub OAuth starter](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth).
`vendor/cloudflare-starter/` records it exactly:

- `SOURCE.json`: the repository, folder and commit it came from.
- `upstream/`: the files exactly as published at that commit.
- `patches/`: every change this project makes to them, as readable diffs.

| Command | What it does |
| --- | --- |
| `npm run vendor:check` | Fails unless the upstream copies plus the patches reproduce `src/` exactly. Part of `npm test`, works offline. |
| `npm run vendor:update` | Rewrites the patches after an intentional change to one of those files. |
| `npm run vendor:verify` | Downloads the files from GitHub. Fails if the upstream copies were edited, or if Cloudflare has changed the files since, so you can review their changes. |

`vendor:verify` also runs automatically every Monday through the GitHub Actions
workflow in `.github/workflows/vendor-watch.yml`, and can be run by hand from
the repository's Actions tab. If Cloudflare has changed the files, it opens an
issue titled "Cloudflare starter files changed upstream", or comments on the
one already open, listing the changed files with links to the changes. If the
check itself fails, GitHub sends its usual failed-workflow email.

## Live check

`npm run smoke` (see the README's [Try it](README.md#7-try-it) step) checks a
deployed Worker against your real calendar: it signs in like an MCP client,
then creates, reads, edits, lists and deletes a test event, cleaning up even
if a step fails. Its logic was tested against a local stand-in Worker,
including a failure partway through.

Against the deployed Worker with the https and trusted-host rules in place
(`CALDAV_TRUSTED_HOSTS` set to `.icloud.com`), `npm run smoke` passed every step
on a real iCloud calendar: listing calendars, creating, reading, editing and
listing a test event, deleting it and confirming it was gone. This confirms
iCloud's handoff to its regional servers stays within `.icloud.com`.

Separately from the automated tests, the Worker was deployed and used through
an MCP client against a real iCloud calendar. All of these passed without
errors or retries:

| Check | Result |
| --- | --- |
| Calendar discovery | PASS |
| Event listing | PASS |
| Event creation (disposable timed event) | PASS |
| Direct read-back | PASS |
| Event update (title and times, fresh version) | PASS |
| Event deletion and absence verification | PASS |

The updated event kept its UID and address, a fresh version was used for the
update and the deletion, and no other events were changed.

This assistant check predates the timezone, sign-in and https fixes above; the
smoke test above covers the same steps on the current version. After deploying a
new version, repeat it with the prompts in the README's
[Try it](README.md#7-try-it) step.

## Remaining limits

- Only iCloud has been tested live. Other CalDAV providers are untested.
- Repeating events, timezones and all-day events are tested with sample data
  and, for the main cases below, against iCloud and the iPhone Calendar app.
  Checked live: cancelling one occurrence, renaming one, moving one, splitting a
  series ("this and following") and ending a series early, all on weekly events
  made in the iPhone Calendar app, in a saved timezone, across the November
  daylight-saving change. Also checked live: creating a repeating event with a
  generated timezone, creating an all-day event, editing a whole series (new
  title, location and time of day) and extending an all-day event, all
  confirmed in the iPhone Calendar app. Moving a weekly series to another day
  (with a new rule, and the refusal without one) and changing a monthly rule
  were checked the same way. Not checked live: events with guests, series made
  by other apps, and the clean-up when the old half of a split series can't be shortened
  (fake server only). Treat results flagged `capped` as incomplete.
