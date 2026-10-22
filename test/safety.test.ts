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
