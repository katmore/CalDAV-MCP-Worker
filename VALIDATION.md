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

Nothing in the tests reaches a real account. The calendar server and GitHub are
replaced by fakes, and every secret has a test-only value in
`vitest.config.mts`.

### What the tests check

| File | Covers |
| --- | --- |
| `test/safety.test.ts` | The owner check; the calendar boundary, one test per rule (other hosts, ports, `http`, credentials, query strings, fragments, `..` and encoded slashes, nested folders, non-`.ics` files, look-alike sibling folders); refused saves never counting as success; what counts as a repeating event; timezones staying inside the event that defines them |
| `test/calendar.test.ts` | All six calendar tools against a fake calendar server: what is written and where, the version sent with each change, refused saves, edits keeping alarms and unknown fields, the refusal rules for repeating events, all-day events and invitations, the `capped` flag, the 90-day, 250-event and 500-occurrence limits, input validation, and error messages that hide internal details |
| `test/oauth-utils.test.ts` | Sign-in building blocks: CSRF tokens, one-time sign-in state tied to the browser that started it, the signed "approved apps" cookie (including forged and foreign cookies), HTML escaping and link filtering on the approval page, and the GitHub token exchange |
| `test/github-handler.test.ts` | The sign-in pages: approval, the GitHub callback, refusing any GitHub account but the owner, failed GitHub responses, replayed or cross-browser callbacks, and hidden internal errors |
| `test/index.test.ts` | The whole sign-in end to end, as an MCP client does it: register, approve, sign in through a fake GitHub, exchange the code with PKCE, then list the calendar tools. Also: tokens that are missing, made up or belong to an account no longer allowed; a tampered redirect address; remembered approvals |

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

Full coverage only shows that code ran, not that a test would notice it
breaking. So the safety rules were also checked by deliberately breaking each
one and confirming a test fails. Each of these 23 breakages was caught:

- saves refused by the server reported as success (create, update, delete)
- calendar boundary rules removed (fragments, non-`.ics` files, credentials, backslashes)
- invitations with only attendees allowed to be edited or deleted
- an edit sent without the event's version, dropping the new title, or not
  increasing the event's sequence number
- events with excluded dates no longer treated as repeating
- event lists no longer sorted
- error messages revealing internal details
- one event's timezone affecting others
- the owner check skipped at sign-in or on each request
- GitHub asked who signed in without the token
- sign-in state reusable, the CSRF check skipped, or the browser check skipped
- the weaker "plain" PKCE allowed

### Bugs the tests found

Writing these tests found and fixed:

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

## Live check

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

This check predates the timezone and sign-in fixes above. After deploying a
new version, repeat it with the prompts in `AGENT-TEST-PROMPTS.md`.

## Remaining limits

- Only iCloud has been tested live. Other CalDAV providers are untested.
- Repeating events, timezones and all-day events are covered by automated
  tests with sample data, but not against a wide range of real calendars, and
  daylight-saving transitions are not specifically tested. Treat results flagged `capped` as incomplete, not as free/busy
  answers.
- Editing repeating events, all-day events and invitations is deliberately
  refused.
