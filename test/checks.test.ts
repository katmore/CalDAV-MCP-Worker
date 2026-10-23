import {describe, test} from 'vitest';
import assert from 'node:assert/strict';
import {assertResource,checkWrite,creationResult,isAllowedLogin,isSeries,prepareCalendar,sameResource} from '../src/checks';

const ics=(...lines:string[])=>['BEGIN:VCALENDAR','VERSION:2.0',...lines,'END:VCALENDAR',''].join('\r\n');
const vevent=(...lines:string[])=>['BEGIN:VEVENT',...lines,'END:VEVENT'].join('\r\n');

describe('owner check',()=> {
 test('matches the allowed GitHub login regardless of case',()=> {
  assert.equal(isAllowedLogin('Owner','owner'),true);
  assert.equal(isAllowedLogin('someone','owner'),false);
 });

 test('denies everyone when no login is allowed, and anyone without a login',()=> {
  assert.equal(isAllowedLogin('owner',''),false);
  assert.equal(isAllowedLogin('owner',undefined),false);
  assert.equal(isAllowedLogin(undefined,'owner'),false);
  assert.equal(isAllowedLogin('',''),false);
 });
});

describe('calendar boundary',()=> {
 const CAL='https://calendar.example.test/123/calendars/home/';

 test('accepts an .ics resource directly inside the calendar',()=> {
  assertResource(CAL,CAL+'event.ics');
  assertResource(CAL,CAL+'a%40b.ics'); // servers commonly escape @ in hrefs
 });

 test.each([
  ['another host', 'https://evil.test/123/calendars/home/x.ics'],
  ['another port', 'https://calendar.example.test:8443/123/calendars/home/x.ics'],
  ['plain http', 'http://calendar.example.test/123/calendars/home/x.ics'],
  ['embedded credentials', 'https://u:p@calendar.example.test/123/calendars/home/x.ics'],
  ['a query string', CAL+'x.ics?q=1'],
  ['a fragment', CAL+'x.ics#frag'],
  ['a parent-folder escape', CAL+'../work/x.ics'],
  ['an encoded parent-folder escape', CAL+'%2e%2e/work/x.ics'],
  ['a nested folder', CAL+'nested/x.ics'],
  ['an encoded slash', CAL+'a%2fb.ics'],
  ['an encoded slash in capitals', CAL+'a%2Fb.ics'],
  ['an encoded backslash', CAL+'a%5cb.ics'],
  ['a non-calendar file', CAL+'x.txt'],
  ['the calendar itself', CAL],
  ['a sibling folder sharing the name prefix', 'https://calendar.example.test/123/calendars/homework/x.ics'],
 ])('rejects %s',(_case,resource)=> {
  assert.throws(()=>assertResource(CAL,resource),/Invalid resource/);
 });

 test('treats a calendar address without a trailing slash as a folder',()=> {
  const noSlash='https://calendar.example.test/123/home';
  assertResource(noSlash,noSlash+'/event.ics');
  assert.throws(()=>assertResource(noSlash,'https://calendar.example.test/123/homework/event.ics'),/Invalid resource/);
 });

 test('recognises the same resource when the server escapes characters',()=> {
  assert.equal(sameResource('https://example.test/c/a@b.ics','https://example.test/c/a%40b.ics'),true);
  assert.equal(sameResource('https://example.test/c/a.ics','https://example.test/c/b.ics'),false);
  assert.equal(sameResource('https://example.test/c/a.ics','https://evil.test/c/a.ics'),false);
  assert.equal(sameResource('https://example.test/c/a.ics','https://example.test/c/a.ics?x=1'),false);
 });
});

describe('write results',()=> {
 test('success statuses pass',async()=> {
  for (const status of [200,201,204]) await checkWrite(new Response(null,{status}));
 });

 test('conflicts and other failures are never treated as success',async()=> {
  await assert.rejects(checkWrite(new Response(null,{status:412})),/Conflict/);
  for (const status of [401,403,404,500]) await assert.rejects(checkWrite(new Response(null,{status})),/Write rejected/);
 });

 test('a created event read back from the server reports the server\'s view',async()=> {
  const r=await creationResult('uid','https://example.test/c/a.ics',async()=>({resourceId:'https://example.test/c/a%40.ics',etag:'"v1"'}));
  assert.deepEqual(r,{created:true,uid:'uid',resourceId:'https://example.test/c/a%40.ics',etag:'"v1"',verification:'verified'});
 });

 test('a created event that cannot be read back is still reported as created, without internal details',async()=> {
  const r=await creationResult('uid','https://example.test/c/a.ics',async()=>{throw new RangeError('private detail');});
  assert.equal(r.created,true);
  assert.equal(r.verification,'pending');
  assert.equal(JSON.stringify(r).includes('private detail'),false);
 });
});

describe('repeating events',()=> {
 const events=(...components:string[])=>prepareCalendar(ics(...components)).getAllSubcomponents('vevent');

 test.each([
  ['a repeat rule', vevent('UID:a','DTSTART:20300101T120000Z','RRULE:FREQ=DAILY')],
  ['extra dates only', vevent('UID:a','DTSTART:20300101T120000Z','RDATE:20300102T120000Z')],
  ['excluded dates', vevent('UID:a','DTSTART:20300101T120000Z','EXDATE:20300102T120000Z')],
  ['a single moved occurrence', vevent('UID:a','RECURRENCE-ID:20300102T120000Z','DTSTART:20300102T130000Z')],
 ])('counts an event with %s as repeating',(_case,component)=> {
  assert.equal(isSeries(events(component)),true);
 });

 test('counts several events in one resource as repeating',()=> {
  assert.equal(isSeries(events(vevent('UID:a','DTSTART:20300101T120000Z'),vevent('UID:a','DTSTART:20300102T120000Z'))),true);
 });

 test('does not count a single one-off event',()=> {
  assert.equal(isSeries(events(vevent('UID:a','DTSTART:20300101T120000Z'))),false);
 });
});

describe('timezones',()=> {
 const zone=(offset:string)=>['BEGIN:VTIMEZONE','TZID:Europe/Paris','BEGIN:STANDARD','DTSTART:19700101T000000',`TZOFFSETFROM:${offset}`,`TZOFFSETTO:${offset}`,'END:STANDARD','END:VTIMEZONE'];
 const event=vevent('UID:e','DTSTART;TZID=Europe/Paris:20300103T120000','DTEND;TZID=Europe/Paris:20300103T130000');
 const start=(data:string)=>(prepareCalendar(data).getFirstSubcomponent('vevent')!.getFirstPropertyValue('dtstart') as any);

 test("one resource's timezone definition cannot change how another is read",()=> {
  assert.equal(start(ics(...zone('+0100'),event)).toJSDate().toISOString(),'2030-01-03T11:00:00.000Z');
  start(ics(...zone('+0900'),event)); // a planted, wrong definition of the same zone
  assert.equal(start(ics(...zone('+0100'),event)).toJSDate().toISOString(),'2030-01-03T11:00:00.000Z');
 });

 test('a zone the resource names but does not define is ambiguous, not borrowed',()=> {
  start(ics(...zone('+0900'),event));
  assert.equal(start(ics(event)).zone.tzid,'floating');
 });
});
