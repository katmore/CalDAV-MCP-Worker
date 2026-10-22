import {test} from 'vitest';
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

type Options={calendars?:{url:string;displayName?:string}[];keepCreated?:boolean};

// A stand-in for tsdav's client that serves fixed objects and records writes.
function fakeDAV(objects:Obj[],{calendars=[{url:CAL,displayName:'Home'}],keepCreated=true}:Options={}) {
 const writes:string[]=[];
 const created:any[]=[];
 const client={
  fetchCalendars:async()=>calendars,
  fetchCalendarObjects:async({objectUrls}:{objectUrls?:string[]})=>objectUrls?objects.filter(o=>objectUrls.includes(o.url)):objects,
  createCalendarObject:async(args:any)=>{
   writes.push('create'); created.push(args);
   if (keepCreated) objects.push({url:new URL(args.filename,args.calendar.url.replace(/\/?$/,'/')).href,etag:'"new"',data:args.iCalString});
   return new Response(null,{status:201});
  },
  updateCalendarObject:async()=>{writes.push('update');return new Response(null,{status:204});},
  deleteCalendarObject:async()=>{writes.push('delete');return new Response(null,{status:204});},
 };
 return {connect:(async()=>client) as any,writes,created};
}

// Builds the server with tool registration captured, so handlers can be called directly.
async function tools(objects:Obj[]=[],env:Record<string,string>=ENV,props=OWNER,options:Options={}) {
 const dav=fakeDAV(objects,options);
 const calendar=new CalendarServer(env as any,props,dav.connect);
 const handlers:Record<string,(args:any)=>Promise<any>>={};
 (calendar.server as any).registerTool=(name:string,_config:unknown,handler:(args:any)=>Promise<any>)=>{handlers[name]=handler;};
 await calendar.init();
 const call=async(name:string,args:any)=>{const r=await handlers[name](args);return {isError:!!r.isError,body:JSON.parse(r.content[0].text)};};
 return {handlers,call,writes:dav.writes,created:dav.created};
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

test('list_calendars returns each calendar with a name',async()=> {
 const other='https://calendar.example.test/1/calendars/other/';
 const {call}=await tools([],ENV,OWNER,{calendars:[{url:CAL,displayName:'Home'},{url:other}]});
 assert.deepEqual((await call('list_calendars',{})).body,[{id:CAL,name:'Home'},{id:other,name:'(untitled)'}]);
});

test('get_event returns the event details and raw calendar data',async()=> {
 const data=ics(timed('p','20300103T100000Z','20300103T110000Z','LOCATION:Office'));
 const {call}=await tools([{url:CAL+'plain.ics',etag:'"1"',data}]);
 const r=await call('get_event',{calendarId:CAL,resourceId:CAL+'plain.ics'});
 assert.equal(r.isError,false);
 assert.equal(r.body.etag,'"1"');
 assert.equal(r.body.events[0].title,'Test');
 assert.equal(r.body.events[0].location,'Office');
 assert.equal(r.body.ical,data);
});

test('list_events rejects backwards and overlong ranges',async()=> {
 const {call}=await tools();
 assert.equal((await call('list_events',{...RANGE,start:RANGE.end,end:RANGE.start})).isError,true);
 assert.equal((await call('list_events',{...RANGE,end:'2030-06-01T00:00:00Z'})).isError,true);
});

test('list_events flags results when a series hits the iteration limit',async()=> {
 const {call}=await tools([{url:CAL+'hourly.ics',etag:'"1"',data:ics(timed('h','20270101T000000Z','20270101T003000Z','RRULE:FREQ=HOURLY'))}]);
 const r=await call('list_events',RANGE);
 assert.equal(r.body.capped,true);
 assert.equal(r.body.occurrences.length,0);
});

const NEW={calendarId:CAL,title:'Connector test',start:'2030-01-03T10:00:00Z',end:'2030-01-03T10:30:00Z',location:'Office',description:'Notes'};

test('create_event saves a new event without overwriting and reads it back',async()=> {
 const {call,writes,created}=await tools();
 const r=await call('create_event',NEW);
 assert.equal(r.isError,false);
 assert.equal(r.body.created,true);
 assert.equal(r.body.verification,'verified');
 assert.equal(r.body.events[0].title,'Connector test');
 assert.deepEqual(writes,['create']);
 assert.equal(created[0].headers['If-None-Match'],'*');
 assert.match(created[0].iCalString,/LOCATION:Office/);
});

test('create_event reports success as pending when read-back fails',async()=> {
 const {call}=await tools([],ENV,OWNER,{keepCreated:false});
 const r=await call('create_event',NEW);
 assert.equal(r.isError,false);
 assert.equal(r.body.verification,'pending');
});

test('create_event rejects an end before the start without writing',async()=> {
 const {call,writes}=await tools();
 assert.equal((await call('create_event',{...NEW,end:NEW.start})).isError,true);
 assert.deepEqual(writes,[]);
});

test('update_event changes times, location and description, and rejects an end before the start',async()=> {
 const {call,writes}=await tools([{url:CAL+'plain.ics',etag:'"1"',data:ics(timed('p','20300101T100000Z','20300101T110000Z'))}]);
 const base={calendarId:CAL,resourceId:CAL+'plain.ics',etag:'"1"'};
 assert.equal((await call('update_event',{...base,end:'2030-01-01T09:00:00Z'})).isError,true);
 assert.deepEqual(writes,[]);
 const r=await call('update_event',{...base,start:'2030-01-01T12:00:00Z',end:'2030-01-01T13:00:00Z',location:'Office',description:'Notes'});
 assert.equal(r.isError,false);
 assert.deepEqual(writes,['update']);
});

test('list_events applies a moved occurrence of a repeating event',async()=> {
 const data=ics(
  timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=DAILY;COUNT=3'),
  vevent('UID:w','RECURRENCE-ID:20300102T100000Z','DTSTART:20300102T150000Z','DTEND:20300102T160000Z','SUMMARY:Moved'),
 );
 const {call}=await tools([{url:CAL+'daily.ics',etag:'"1"',data}]);
 const r=await call('list_events',RANGE);
 assert.deepEqual(r.body.occurrences.map((o:any)=>[o.start,o.title]),[
  ['2030-01-01T10:00:00.000Z','Test'],['2030-01-02T15:00:00.000Z','Moved'],['2030-01-03T10:00:00.000Z','Test'],
 ]);
 assert.equal(r.body.capped,false);
});

test('list_events skips cancelled occurrences',async()=> {
 const data=ics(
  timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=DAILY;COUNT=2'),
  vevent('UID:w','RECURRENCE-ID:20300102T100000Z','DTSTART:20300102T100000Z','DTEND:20300102T110000Z','STATUS:CANCELLED'),
 );
 const {call}=await tools([{url:CAL+'daily.ics',etag:'"1"',data}]);
 assert.deepEqual((await call('list_events',RANGE)).body.occurrences.map((o:any)=>o.start),['2030-01-01T10:00:00.000Z']);
});

test('list_events uses a timezone embedded in the event',async()=> {
 const data=ics(
  'BEGIN:VTIMEZONE','TZID:Test/Plus2','BEGIN:STANDARD','DTSTART:19700101T000000','TZOFFSETFROM:+0200','TZOFFSETTO:+0200','END:STANDARD','END:VTIMEZONE',
  vevent('UID:z','DTSTART;TZID=Test/Plus2:20300103T120000','DTEND;TZID=Test/Plus2:20300103T130000','SUMMARY:Zoned'),
 );
 const {call}=await tools([{url:CAL+'zoned.ics',etag:'"1"',data}]);
 const r=await call('list_events',RANGE);
 assert.equal(r.body.occurrences[0].start,'2030-01-03T10:00:00.000Z');
 assert.equal(r.body.capped,false);
});

test('list_events flags events saved without a timezone',async()=> {
 const {call}=await tools([{url:CAL+'floating.ics',etag:'"1"',data:ics(vevent('UID:f','DTSTART:20300103T100000','DTEND:20300103T110000','SUMMARY:Floating'))}]);
 assert.equal((await call('list_events',RANGE)).body.capped,true);
});

test('list_events refuses too many resources or occurrences',async()=> {
 const many=Array.from({length:251},(_,i)=>({url:CAL+`e${i}.ics`,etag:'"1"',data:ics(timed(`e${i}`,'20300103T100000Z','20300103T110000Z'))}));
 assert.equal((await (await tools(many)).call('list_events',RANGE)).isError,true);
 const hourly=[{url:CAL+'hourly.ics',etag:'"1"',data:ics(timed('h','20300101T000000Z','20300101T003000Z','RRULE:FREQ=HOURLY'))}];
 const r=await (await tools(hourly)).call('list_events',{...RANGE,end:'2030-01-30T00:00:00Z'});
 assert.equal(r.isError,true);
});

test('get_event fills in missing event fields with empty text',async()=> {
 const {call}=await tools([{url:CAL+'bare.ics',etag:'"1"',data:ics(vevent('X-NOTHING:1'))}]);
 const r=await call('get_event',{calendarId:CAL,resourceId:CAL+'bare.ics'});
 assert.deepEqual(r.body.events[0],{uid:'',title:'',start:'',end:'',rrule:'',recurrenceId:'',location:''});
});

test('get_event reports a resource with no calendar data as a failure',async()=> {
 const {call}=await tools([{url:CAL+'empty.ics',etag:'"1"',data:undefined as any}]);
 const r=await call('get_event',{calendarId:CAL,resourceId:CAL+'empty.ics'});
 assert.equal(r.isError,true);
 assert.equal(r.body.error,'CalDAV operation failed');
});

test('failures never expose what was thrown, even if it is not an Error',async()=> {
 const calendar=new CalendarServer(ENV as any,OWNER,(async()=>({fetchCalendars:async()=>{throw 'password=hunter2';}})) as any);
 let handler:any;
 (calendar.server as any).registerTool=(name:string,_c:unknown,h:any)=>{if(name==='list_calendars')handler=h;};
 await calendar.init();
 const body=JSON.parse((await handler({})).content[0].text);
 assert.deepEqual(body,{error:'CalDAV operation failed',reason:'unknown'});
});

test('create_event leaves out an empty location and description',async()=> {
 const {call,created}=await tools();
 const {location,description,...bare}=NEW;
 assert.equal((await call('create_event',bare)).isError,false);
 assert.doesNotMatch(created[0].iCalString,/LOCATION|DESCRIPTION/);
});

test('create_event places the event inside a calendar whose address lacks a trailing slash',async()=> {
 const noSlash=CAL.slice(0,-1);
 const {call}=await tools([],ENV,OWNER,{calendars:[{url:noSlash,displayName:'Home'}]});
 const r=await call('create_event',{...NEW,calendarId:noSlash});
 assert.match(r.body.resourceId,new RegExp('^'+CAL+'[0-9a-f-]{36}\\.ics$'));
 assert.equal(r.body.verification,'verified');
});
