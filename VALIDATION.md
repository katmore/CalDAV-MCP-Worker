# Validation status

Checks performed on the Worker:

- TypeScript type check and safety regression tests pass (resource boundaries,
  rejected HTTP writes, RDATE protection, accepted-write/read-back-failure and
  DAV URL escaping cases).
- `wrangler deploy --dry-run` bundles successfully.
- Public HTTPS and OAuth discovery work (authorization code, refresh token,
  dynamic registration and S256 advertised); an unauthenticated MCP request
  returns 401.
- Dependency audit reported no known vulnerabilities at the time of checking.

## End-to-end test

Using an MCP client against a deployed instance, all of these passed
without errors or retries:

| Check | Result |
| --- | --- |
| Calendar discovery | PASS |
| Event listing | PASS |
| Event creation (disposable timed event) | PASS |
| Direct read-back | PASS |
| Event update (title and times, fresh ETag) | PASS |
| Event deletion and absence verification | PASS |

The updated resource kept its UID and resource ID, fresh ETags were used for
update and deletion, and no other calendar resources were changed.

## Remaining limits

Recurring reads, DST edge cases, all-day handling, session renewal, and non-owner
denial have not been fully verified against a live integration. Recurring,
all-day and invitation editing restrictions remain in place. Recurring reads are
conservative and should not be treated as verified free/busy data.
