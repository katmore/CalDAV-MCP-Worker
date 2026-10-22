# Test prompts

Paste these into your assistant after connecting it, and again after each
deploy. Go in order and stop at the first failure. Keep your calendar app open
to compare, and use a calendar you don't mind testing in.

## 1. List calendars

```
Using the calendar connector, list all of my calendars.
```

You should see the same calendars as your calendar app. "CalDAV operation
failed" means a wrong username, password or `CALDAV_URL`; "Not authorized" or
"Forbidden" means you signed in as the wrong GitHub account.

## 2. Read events

```
Show me the events on my <calendar name> calendar for this week.
```

Check the times against your calendar app, especially repeating events. A
`capped` result is normal when a repeating event runs past the end of the week.

## 3. Create a test event

```
Create an event called "Connector test" on my <calendar name> calendar, <day> from <start time> to <end time>. Then read it back and show me what was saved.
```

It should show up in your calendar app. If the request times out, ask the
assistant to list that day's events before trying again, to avoid a duplicate.

## 4. Change it

```
Rename the "Connector test" event to "Connector test (edited)" and move it 30 minutes later. Then read it back.
```

If it fails, the event may have changed since it was read; ask the assistant
to read it again and retry.

## 5. Delete it

```
Delete the "Connector test (edited)" event, then list that day's events to confirm it's gone.
```

Nothing else on that day should change.

## 6. Safety rules (optional)

Both of these should fail and leave your calendar unchanged.

```
Change the title of my repeating <event name> event.
```

```
Change the time of the <event name> invitation.
```
