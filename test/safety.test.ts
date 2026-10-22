import {test} from 'vitest';
import assert from 'node:assert/strict';
import {assertResource,checkWrite,isSeries,prepareCalendar,sameResource,creationResult} from '../src/safety';
test('reject resources outside the discovered calendar',()=> {
 const c='https://calendar.example.test/123/calendars/home/';
 assertResource(c,c+'event.ics');
 for (const r of ['https://evil.test/x.ics', c+'../work/x.ics',c+'nested/x.ics',c+'a%2fb.ics',c+'x.ics?q=1']) assert.throws(()=>assertResource(c,r));
});
test('failed writes including conflicts never become success',async()=> {
 for (const code of [401,403,412,500]) await assert.rejects(checkWrite(new Response(null,{status:code})));
 await checkWrite(new Response(null,{status:201}));
});
test('RDATE-only recurrence is protected from single-event edits',()=> {
 const root=prepareCalendar('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20300101T120000Z\r\nRDATE:20300102T120000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
 assert.equal(isSeries(root.getAllSubcomponents('vevent')),true);
});

test('DAV escaping of @ does not hide the created resource',()=> {
 assert.equal(sameResource('https://example.test/c/a@b.ics','https://example.test/c/a%40b.ics'),true);
 assert.equal(sameResource('https://example.test/c/a.ics','https://example.test/c/b.ics'),false);
 assert.equal(sameResource('https://example.test/c/a.ics','https://evil.test/c/a.ics'),false);
});
test('accepted creation remains successful when read-back fails',async()=> {
 const r=await creationResult('uid','https://example.test/c/a.ics',async()=>{throw new RangeError('private detail');});
 assert.equal(r.created,true); assert.equal(r.verification,'pending');
 assert.equal(JSON.stringify(r).includes('private detail'),false);
});
test('verified creation returns canonical read-back information',async()=> {
 const r=await creationResult('uid','https://example.test/c/a.ics',async()=>({etag:'"v1"'}));
 assert.equal(r.verification,'verified'); assert.equal(r.created,true);
 assert.equal('etag' in r && r.etag,'"v1"');
});

test('a calendar address without a trailing slash still bounds its resources',()=> {
 assertResource('https://calendar.example.test/123/home','https://calendar.example.test/123/home/event.ics');
 assert.throws(()=>assertResource('https://calendar.example.test/123/home','https://calendar.example.test/123/homework/event.ics'));
});

test("one resource's timezone definition cannot change how another resource is read",()=> {
 const ics=(...l:string[])=>['BEGIN:VCALENDAR','VERSION:2.0',...l,'END:VCALENDAR',''].join('\r\n');
 const zone=(offset:string)=>['BEGIN:VTIMEZONE','TZID:Europe/Paris','BEGIN:STANDARD','DTSTART:19700101T000000',`TZOFFSETFROM:${offset}`,`TZOFFSETTO:${offset}`,'END:STANDARD','END:VTIMEZONE'];
 const event=['BEGIN:VEVENT','UID:e','DTSTART;TZID=Europe/Paris:20300103T120000','DTEND;TZID=Europe/Paris:20300103T130000','END:VEVENT'];
 const start=(data:string)=>(prepareCalendar(data).getFirstSubcomponent('vevent')!.getFirstPropertyValue('dtstart') as any);
 assert.equal(start(ics(...zone('+0100'),...event)).toJSDate().toISOString(),'2030-01-03T11:00:00.000Z');
 start(ics(...zone('+0900'),...event)); // a planted, wrong definition of the same zone
 assert.equal(start(ics(...zone('+0100'),...event)).toJSDate().toISOString(),'2030-01-03T11:00:00.000Z');
 assert.equal(start(ics(...event)).zone.tzid,'floating','an undefined zone is ambiguous, not borrowed');
});
