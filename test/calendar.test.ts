import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CalendarServer} from '../src/calendar';
import {isAllowedLogin} from '../src/safety';

const CAL='https://calendar.example.test/1/calendars/home/';
const ENV={CALDAV_URL:'https://calendar.example.test/',CALDAV_USERNAME:'user',CALDAV_PASSWORD:'pass',ALLOWED_GITHUB_LOGIN:'owner'};
const OWNER={login:'owner',name:'Owner',email:'owner@example.test'};

type Obj={url:string;etag:string;data:string};
const ics=(...lines:string[])=>['BEGIN:VCALENDAR','VERSION:2.0',...lines,'END:VCALENDAR',''].join('\r\n');
const vevent=(...lines:string[])=>['BEGIN:VEVENT',...lines,'END:VEVENT'].join('\r\n');
const timed=(uid:string,start:string,end:string,...extra:string[])=>vevent(`UID:${uid}`,`DTSTART:${start}`,`DTEND:${end}`,'SUMMARY:Test',...extra);

// A stand-in for tsdav's client that serves fixed objects and records writes.
function fakeDAV(objects:Obj[]) {
 const writes:string[]=[];
 const client={
  fetchCalendars:async()=>[{url:CAL,displayName:'Home'}],
  fetchCalendarObjects:async({objectUrls}:{objectUrls?:string[]})=>objectUrls?objects.filter(o=>objectUrls.includes(o.url)):objects,
  createCalendarObject:async()=>{writes.push('create');return new Response(null,{status:201});},
  updateCalendarObject:async()=>{writes.push('update');return new Response(null,{status:204});},
  deleteCalendarObject:async()=>{writes.push('delete');return new Response(null,{status:204});},
 };
 return {connect:(async()=>client) as any,writes};
}

// Builds the server with tool registration captured, so handlers can be called directly.
async function tools(objects:Obj[]=[],env:Record<string,string>=ENV,props=OWNER) {
 const dav=fakeDAV(objects);
 const calendar=new CalendarServer(env as any,props,dav.connect);
 const handlers:Record<string,(args:any)=>Promise<any>>={};
 (calendar.server as any).registerTool=(name:string,_config:unknown,handler:(args:any)=>Promise<any>)=>{handlers[name]=handler;};
 await calendar.init();
 const call=async(name:string,args:any)=>{const r=await handlers[name](args);return {isError:!!r.isError,body:JSON.parse(r.content[0].text)};};
 return {handlers,call,writes:dav.writes};
}

test('owner check is case-insensitive and denies when unset or empty',()=> {
 assert.equal(isAllowedLogin('Owner','owner'),true);
 assert.equal(isAllowedLogin('someone','owner'),false);
 assert.equal(isAllowedLogin('owner',''),false);
 assert.equal(isAllowedLogin('owner',undefined),false);
 assert.equal(isAllowedLogin(undefined,'owner'),false);
 assert.equal(isAllowedLogin('',''),false);
});

test('no calendar tools are registered for anyone but the owner',async()=> {
 assert.equal(Object.keys((await tools([],ENV,{...OWNER,login:'someone'})).handlers).length,0);
 assert.equal(Object.keys((await tools([],{...ENV,ALLOWED_GITHUB_LOGIN:''})).handlers).length,0);
 assert.deepEqual(Object.keys((await tools()).handlers).sort(),['create_event','delete_event','get_event','list_calendars','list_events','update_event']);
});

test('a missing CALDAV_URL is reported as a configuration error',async()=> {
 const {call}=await tools([],{...ENV,CALDAV_URL:''});
 const r=await call('list_calendars',{});
 assert.equal(r.isError,true);
 assert.match(r.body.error,/CALDAV_URL must be set/);
});

const RANGE={calendarId:CAL,start:'2030-01-01T00:00:00Z',end:'2030-01-15T00:00:00Z'};

test('list_events skips a resource holding only overridden occurrences and flags the result',async()=> {
 const {call}=await tools([
  {url:CAL+'orphan.ics',etag:'"1"',data:ics(vevent('UID:o','RECURRENCE-ID:20300102T100000Z','DTSTART:20300102T110000Z','DTEND:20300102T120000Z','SUMMARY:Moved'))},
  {url:CAL+'plain.ics',etag:'"1"',data:ics(timed('p','20300103T100000Z','20300103T110000Z'))},
 ]);
 const r=await call('list_events',RANGE);
 assert.equal(r.isError,false);
 assert.equal(r.body.capped,true);
 assert.deepEqual(r.body.occurrences.map((o:any)=>o.resourceId),[CAL+'plain.ics']);
});

test('list_events keeps capped set when a later event starts after the range',async()=> {
 const {call}=await tools([
  {url:CAL+'weekly.ics',etag:'"1"',data:ics(timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=WEEKLY'))},
  {url:CAL+'later.ics',etag:'"1"',data:ics(timed('l','20300120T100000Z','20300120T110000Z'))},
 ]);
 const r=await call('list_events',RANGE);
 assert.equal(r.body.capped,true);
 assert.equal(r.body.occurrences.length,2);
});

test('list_events is not capped for one-off events inside the range',async()=> {
 const {call}=await tools([{url:CAL+'plain.ics',etag:'"1"',data:ics(timed('p','20300103T100000Z','20300103T110000Z'))}]);
 assert.equal((await call('list_events',RANGE)).body.capped,false);
});

const edit=(url:string,etag='"1"')=>({calendarId:CAL,resourceId:url,etag,title:'Renamed'});

test('update_event refuses repeating, all-day, invitation and changed events without writing',async()=> {
 const {call,writes}=await tools([
  {url:CAL+'series.ics',etag:'"1"',data:ics(timed('s','20300101T100000Z','20300101T110000Z','RRULE:FREQ=DAILY'))},
  {url:CAL+'allday.ics',etag:'"1"',data:ics(vevent('UID:d','DTSTART;VALUE=DATE:20300101','DTEND;VALUE=DATE:20300102','SUMMARY:Day'))},
  {url:CAL+'invite.ics',etag:'"1"',data:ics(timed('i','20300101T100000Z','20300101T110000Z','ORGANIZER:mailto:a@example.test','ATTENDEE:mailto:b@example.test'))},
  {url:CAL+'plain.ics',etag:'"2"',data:ics(timed('p','20300101T100000Z','20300101T110000Z'))},
 ]);
 for (const name of ['series','allday','invite']) assert.equal((await call('update_event',edit(CAL+name+'.ics'))).isError,true,name);
 assert.equal((await call('update_event',edit(CAL+'plain.ics','"1"'))).isError,true,'stale etag');
 assert.deepEqual(writes,[]);
});

test('update_event refuses time changes to duration-based events but allows other edits',async()=> {
 const {call,writes}=await tools([{url:CAL+'dur.ics',etag:'"1"',data:ics(vevent('UID:u','DTSTART:20300101T100000Z','DURATION:PT1H','SUMMARY:Test'))}]);
 assert.equal((await call('update_event',{calendarId:CAL,resourceId:CAL+'dur.ics',etag:'"1"',start:'2030-01-01T11:00:00Z'})).isError,true);
 assert.equal((await call('update_event',edit(CAL+'dur.ics'))).isError,false);
 assert.deepEqual(writes,['update']);
});

test('update_event writes a one-off event when the etag matches',async()=> {
 const {call,writes}=await tools([{url:CAL+'plain.ics',etag:'"1"',data:ics(timed('p','20300101T100000Z','20300101T110000Z'))}]);
 const r=await call('update_event',edit(CAL+'plain.ics'));
 assert.equal(r.isError,false);
 assert.equal(r.body.updated,true);
 assert.deepEqual(writes,['update']);
});

const del=(url:string,extra={})=>({calendarId:CAL,resourceId:url,etag:'"1"',confirm:'DELETE',confirmEntireSeries:false,...extra});

test('delete_event refuses invitations, unconfirmed series and changed events',async()=> {
 const {call,writes}=await tools([
  {url:CAL+'invite.ics',etag:'"1"',data:ics(timed('i','20300101T100000Z','20300101T110000Z','ORGANIZER:mailto:a@example.test'))},
  {url:CAL+'series.ics',etag:'"1"',data:ics(timed('s','20300101T100000Z','20300101T110000Z','RRULE:FREQ=DAILY'))},
  {url:CAL+'plain.ics',etag:'"2"',data:ics(timed('p','20300101T100000Z','20300101T110000Z'))},
 ]);
 assert.equal((await call('delete_event',del(CAL+'invite.ics',{confirmEntireSeries:true}))).isError,true,'invitation');
 assert.equal((await call('delete_event',del(CAL+'series.ics'))).isError,true,'unconfirmed series');
 assert.equal((await call('delete_event',del(CAL+'plain.ics'))).isError,true,'stale etag');
 assert.deepEqual(writes,[]);
});

test('delete_event removes a series only with whole-series confirmation',async()=> {
 const {call,writes}=await tools([{url:CAL+'series.ics',etag:'"1"',data:ics(timed('s','20300101T100000Z','20300101T110000Z','RRULE:FREQ=DAILY'))}]);
 assert.equal((await call('delete_event',del(CAL+'series.ics',{confirmEntireSeries:true}))).isError,false);
 assert.deepEqual(writes,['delete']);
});

test('tools refuse events outside the discovered calendar',async()=> {
 const {call,writes}=await tools([{url:'https://calendar.example.test/1/calendars/work/x.ics',etag:'"1"',data:ics(timed('x','20300101T100000Z','20300101T110000Z'))}]);
 assert.equal((await call('get_event',{calendarId:CAL,resourceId:'https://calendar.example.test/1/calendars/work/x.ics'})).isError,true);
 assert.equal((await call('list_events',{...RANGE,calendarId:'https://calendar.example.test/1/calendars/work/'})).isError,true);
 assert.deepEqual(writes,[]);
});
