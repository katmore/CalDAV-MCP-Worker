# Test prompts

Prompts to paste into your AI assistant to check that a deployed CalDAV MCP
Worker works end to end. Run them after you connect the assistant (step 6 of
the README setup), and again after you change secrets or redeploy.

The prompts go from harmless reads to writes. Do them in order, and stop at
the first one that fails: later prompts depend on earlier ones working. Keep
your usual calendar app open alongside, so you can check each answer against
it.

The write tests create, change and delete one event. Pick a calendar you don't
mind experimenting in, and a time slot with nothing else in it.

## 1. List calendars

```
Using the calendar connector, list all of my calendars.
```

**What it checks:** sign-in worked, the Worker can reach your CalDAV server,
and your username, password and `CALDAV_URL` are right.

**Expect:** the same calendar names you see in your calendar app. Some
providers also return calendars you don't normally see, such as reminders or
birthdays.

**If it fails:** "CalDAV operation failed" usually means a wrong username,
password or `CALDAV_URL`. "Not authorized" or "Forbidden" means you're signed
in as a different GitHub account than `ALLOWED_GITHUB_LOGIN`. See
Troubleshooting in the README.

## 2. Read events

```
Show me the events on my <calendar name> calendar for this week.
```

**What it checks:** reading events over a date range.

**Expect:** the same events your calendar app shows for this week, with the
right times in your timezone.

Two things are normal:

- The answer may say the results are `capped` (possibly incomplete). This
  happens whenever a recurring event continues past the end of the range, so
  it's common. It means "don't treat this as proof that you're free", not that
  something is broken.
- Event times are returned in UTC, so check that the assistant converted them
  to your timezone correctly.

If you have recurring events or events moved from their usual time, look at
those closely; they're the hardest part to get right.

## 3. Create a test event

```
Create an event called "Connector test" on my <calendar name> calendar, <day> from <start time> to <end time>. Then read it back and show me what was saved.
```

**What it checks:** creating events, and that the server saved what was
asked for.

**Expect:** the assistant reports the event was created and shows the saved
title and times. It should appear in your calendar app within a minute or
so, depending on how often the app syncs.

**If it times out:** don't just ask again. Ask it to list that day's events
first; the event may have been created anyway, and retrying would make a
duplicate.

## 4. Change the test event

```
Rename the "Connector test" event to "Connector test (edited)" and move it 30 minutes later. Then read it back.
```

**What it checks:** updating an event. The assistant has to read the event
first to get its current version, and the update is refused if the event
changed in the meantime.

**Expect:** the new title and times, both in the reply and in your calendar
app.

If the update fails with "CalDAV operation failed" (reason `RangeError`), the
event probably changed since the assistant read it, which is the safety check
working. Ask it to read the event again and retry.

## 5. Delete the test event

```
Delete the "Connector test (edited)" event, then list that day's events to confirm it's gone.
```

**What it checks:** deleting an event, and that nothing else was touched.

**Expect:** the event disappears from the reply and from your calendar app,
and the rest of that day's events are unchanged. The assistant may ask you to
confirm before deleting; that's intended.

## 6. Check the safety rules (optional)

These should be refused. Use a recurring event or an invitation you already
have, and don't confirm anything if the assistant asks.

```
Change the title of my recurring <event name> event.
```

```
Change the time of the <event name> invitation.
```

**Expect:** an error, and no change in your calendar app. The server doesn't
explain why, so the assistant will see "CalDAV operation failed" with reason
`RangeError` rather than a specific message. Editing recurring events, all-day
events and invitations isn't supported.

## When everything passes

Your Worker is working. Delete any test events left over, and if you used a
calendar just for testing, you can remove it from your calendar app.
