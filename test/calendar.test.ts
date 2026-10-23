import {describe, test} from 'vitest';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import {CalendarServer} from '../src/calendar';

const CAL='https://calendar.example.test/1/calendars/home/';
const ENV={CALDAV_URL:'https://calendar.example.test/',CALDAV_USERNAME:'user',CALDAV_PASSWORD:'pass',ALLOWED_GITHUB_LOGIN:'owner'};
const OWNER={login:'owner',name:'Owner',email:'owner@example.test'};

type Obj={url:string;etag:string;data:string};
type Write={op:'create'|'update'|'delete';url:string;etag?:string;data?:string;headers?:Record<string,string>};
const ics=(...lines:string[])=>['BEGIN:VCALENDAR','VERSION:2.0',...lines,'END:VCALENDAR',''].join('\r\n');
const vevent=(...lines:string[])=>['BEGIN:VEVENT',...lines,'END:VEVENT'].join('\r\n');
const timed=(uid:string,start:string,end:string,...extra:string[])=>vevent(`UID:${uid}`,`DTSTART:${start}`,`DTEND:${end}`,'SUMMARY:Test',...extra);
const obj=(name:string,data:string,etag='"1"'):Obj=>({url:CAL+name,etag,data});

type Options={
 calendars?:{url:string;displayName?:string}[];
 keepCreated?:boolean;           // store created events so they can be read back
 writeStatus?:number;            // status the server answers every write with
 fetchObjects?:(urls?:string[])=>Obj[]; // replace what the server returns for a fetch
 client?:unknown;                // replace the whole client
};

// A stand-in for tsdav's client. Writes are recorded with the arguments the real client
// would use: the target URL, the etag it sends as If-Match, and the data written.
function fakeDAV(objects:Obj[],{calendars=[{url:CAL,displayName:'Home'}],keepCreated=true,writeStatus,fetchObjects,client}:Options={}) {
 const writes:Write[]=[];
 const fetches:any[]=[];
 const fake=client ?? {
  fetchCalendars:async()=>calendars,
  fetchCalendarObjects:async(args:{objectUrls?:string[];timeRange?:unknown})=>{
   fetches.push(args);
   if (fetchObjects) return fetchObjects(args.objectUrls);
   return args.objectUrls?objects.filter(o=>args.objectUrls!.includes(o.url)):objects;
  },
  createCalendarObject:async({calendar,filename,iCalString,headers}:any)=>{
   const url=new URL(filename,calendar.url.replace(/\/?$/,'/')).href;
   writes.push({op:'create',url,data:iCalString,headers});
   const status=writeStatus??201;
   if (status<300 && keepCreated) objects.push({url,etag:'"new"',data:iCalString});
   return new Response(null,{status});
  },
  updateCalendarObject:async({calendarObject}:any)=>{
   writes.push({op:'update',url:calendarObject.url,etag:calendarObject.etag,data:calendarObject.data});
   return new Response(null,{status:writeStatus??204});
  },
  deleteCalendarObject:async({calendarObject}:any)=>{
   writes.push({op:'delete',url:calendarObject.url,etag:calendarObject.etag});
   return new Response(null,{status:writeStatus??204});
  },
 };
 return {connect:(async()=>fake) as any,writes,fetches};
}

// Builds the server with tool registration captured. Calls go through each tool's input
// schema first, as the MCP layer does, so defaults and validation apply.
async function tools(objects:Obj[]=[],env:Record<string,string>=ENV,props=OWNER,options:Options={}) {
 const dav=fakeDAV(objects,options);
 const calendar=new CalendarServer(env as any,props,dav.connect);
 const registered:Record<string,{config:any;handler:(args:any)=>Promise<any>}>={};
 (calendar.server as any).registerTool=(name:string,config:any,handler:any)=>{registered[name]={config,handler};};
 await calendar.init();
 const call=async(name:string,args:any)=>{
  const {config,handler}=registered[name];
  const r=await handler(config.inputSchema.parse(args));
  return {isError:!!r.isError,body:JSON.parse(r.content[0].text)};
 };
 return {registered,call,writes:dav.writes,fetches:dav.fetches};
}

const parse=(data:string)=>new ICAL.Component(ICAL.parse(data));
const only=(data:string)=>{const events=parse(data).getAllSubcomponents('vevent');assert.equal(events.length,1);return events[0];};
const text=(ev:ICAL.Component,name:string)=>String(ev.getFirstPropertyValue(name));

const RANGE={calendarId:CAL,start:'2030-01-01T00:00:00Z',end:'2030-01-15T00:00:00Z'};
const NEW={calendarId:CAL,title:'Connector test',start:'2030-01-03T10:00:00Z',end:'2030-01-03T10:30:00Z',location:'Office',description:'Notes'};
const edit=(url:string,extra={})=>({calendarId:CAL,resourceId:url,etag:'"1"',title:'Renamed',...extra});
const del=(url:string,extra={})=>({calendarId:CAL,resourceId:url,etag:'"1"',confirm:'DELETE',...extra});
const INVITES={
 organizer:timed('i','20300101T100000Z','20300101T110000Z','ORGANIZER:mailto:a@example.test'),
 attendee:timed('i','20300101T100000Z','20300101T110000Z','ATTENDEE:mailto:b@example.test'),
};

describe('access',()=> {
 test('no calendar tools are offered to anyone but the owner',async()=> {
  assert.equal(Object.keys((await tools([],ENV,{...OWNER,login:'someone'})).registered).length,0);
  assert.equal(Object.keys((await tools([],{...ENV,ALLOWED_GITHUB_LOGIN:''})).registered).length,0);
  assert.equal(Object.keys((await tools([],ENV,null as any)).registered).length,0);
  assert.deepEqual(Object.keys((await tools()).registered).sort(),['create_event','delete_event','get_event','list_calendars','list_events','update_event']);
 });

 test('a missing or blank CALDAV_URL is reported as a configuration error',async()=> {
  for (const url of ['','   ']) {
   const r=await (await tools([],{...ENV,CALDAV_URL:url})).call('list_calendars',{});
   assert.equal(r.isError,true);
   assert.match(r.body.error,/CALDAV_URL must be set/);
  }
 });
});

describe('tool definitions',()=> {
 test('read tools are marked read-only and change tools as such',async()=> {
  const {registered}=await tools();
  const hints=Object.fromEntries(Object.entries(registered).map(([n,{config}])=>[n,[config.annotations.readOnlyHint,config.annotations.destructiveHint]]));
  assert.deepEqual(hints,{
   list_calendars:[true,false],list_events:[true,false],get_event:[true,false],
   create_event:[false,false],update_event:[false,true],delete_event:[false,true],
  });
 });

 test('delete requires the literal confirmation DELETE',async()=> {
  const schema=(await tools()).registered.delete_event.config.inputSchema;
  const base={calendarId:CAL,resourceId:CAL+'a.ics',etag:'"1"'};
  assert.equal(schema.safeParse(base).success,false);
  assert.equal(schema.safeParse({...base,confirm:'yes'}).success,false);
  assert.equal(schema.parse({...base,confirm:'DELETE'}).confirmEntireSeries,false,'whole-series deletion is off unless asked for');
 });

 test('changes require a known version and times with a timezone offset',async()=> {
  const {registered}=await tools();
  const update=registered.update_event.config.inputSchema;
  assert.equal(update.safeParse({calendarId:CAL,resourceId:CAL+'a.ics',etag:''}).success,false);
  const create=registered.create_event.config.inputSchema;
  assert.equal(create.safeParse({...NEW,start:'2030-01-03T10:00:00'}).success,false);
  assert.equal(create.safeParse({...NEW,title:''}).success,false);
  assert.equal(create.safeParse({...NEW,title:'x'.repeat(501)}).success,false);
  assert.equal(create.safeParse(NEW).success,true);
 });
});

describe('error reporting',()=> {
 const failingWith=(thrown:unknown)=>tools([],ENV,OWNER,{client:{fetchCalendars:async()=>{throw thrown;}}});

 test('an error carrying a URL and credentials is reported only by its type',async()=> {
  const r=await (await failingWith(new TypeError('401 from https://user:hunter2@calendar.example.test/x'))).call('list_calendars',{});
  assert.equal(r.isError,true);
  assert.deepEqual(r.body,{error:'CalDAV operation failed',reason:'TypeError'});
 });

 test('something thrown that is not an Error reveals nothing',async()=> {
  const r=await (await failingWith('password=hunter2')).call('list_calendars',{});
  assert.deepEqual(r.body,{error:'CalDAV operation failed',reason:'unknown'});
 });
});

describe('list_calendars',()=> {
 test('returns each calendar with a name',async()=> {
  const other='https://calendar.example.test/1/calendars/other/';
  const {call}=await tools([],ENV,OWNER,{calendars:[{url:CAL,displayName:'Home'},{url:other}]});
  assert.deepEqual((await call('list_calendars',{})).body,[{id:CAL,name:'Home'},{id:other,name:'(untitled)'}]);
 });
});

describe('get_event',()=> {
 test('returns the event details and raw calendar data',async()=> {
  const data=ics(timed('p','20300103T100000Z','20300103T110000Z','LOCATION:Office'));
  const r=await (await tools([obj('plain.ics',data)])).call('get_event',{calendarId:CAL,resourceId:CAL+'plain.ics'});
  assert.equal(r.isError,false);
  assert.equal(r.body.etag,'"1"');
  assert.equal(r.body.events[0].title,'Test');
  assert.equal(r.body.events[0].location,'Office');
  assert.equal(r.body.ical,data);
 });

 test('reports missing event fields as empty text',async()=> {
  const r=await (await tools([obj('bare.ics',ics(vevent('X-NOTHING:1')))])).call('get_event',{calendarId:CAL,resourceId:CAL+'bare.ics'});
  assert.deepEqual(r.body.events[0],{uid:'',title:'',start:'',end:'',rrule:'',recurrenceId:'',location:''});
 });

 test('reports a resource with no calendar data as a failure',async()=> {
  const r=await (await tools([obj('empty.ics',undefined as any)])).call('get_event',{calendarId:CAL,resourceId:CAL+'empty.ics'});
  assert.equal(r.isError,true);
 });
});

describe('list_events',()=> {
 const list=async(objects:Obj[],range:Partial<typeof RANGE>={})=>(await tools(objects)).call('list_events',{...RANGE,...range});
 const starts=(r:any)=>r.body.occurrences.map((o:any)=>o.start);

 test('asks the server for the requested range and returns occurrences in time order',async()=> {
  const {call,fetches}=await tools([
   obj('later.ics',ics(timed('b','20300105T090000Z','20300105T100000Z'))),
   obj('earlier.ics',ics(timed('a','20300103T090000Z','20300103T100000Z'))),
  ]);
  const r=await call('list_events',RANGE);
  assert.deepEqual(fetches[0].timeRange,{start:RANGE.start,end:RANGE.end});
  assert.deepEqual(starts(r),['2030-01-03T09:00:00.000Z','2030-01-05T09:00:00.000Z']);
  assert.equal(r.body.capped,false);
 });

 test('includes an event overlapping the start of the range but not one ending exactly at it',async()=> {
  const r=await list([
   obj('overlap.ics',ics(timed('o','20291231T230000Z','20300101T010000Z'))),
   obj('before.ics',ics(timed('b','20291231T230000Z','20300101T000000Z'))),
  ]);
  assert.deepEqual(starts(r),['2029-12-31T23:00:00.000Z']);
 });

 test('applies a moved occurrence of a repeating event',async()=> {
  const r=await list([obj('daily.ics',ics(
   timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=DAILY;COUNT=3'),
   vevent('UID:w','RECURRENCE-ID:20300102T100000Z','DTSTART:20300102T150000Z','DTEND:20300102T160000Z','SUMMARY:Moved'),
  ))]);
  assert.deepEqual(r.body.occurrences.map((o:any)=>[o.start,o.title]),[
   ['2030-01-01T10:00:00.000Z','Test'],['2030-01-02T15:00:00.000Z','Moved'],['2030-01-03T10:00:00.000Z','Test'],
  ]);
  assert.equal(r.body.capped,false);
 });

 test('skips cancelled occurrences',async()=> {
  const r=await list([obj('daily.ics',ics(
   timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=DAILY;COUNT=2'),
   vevent('UID:w','RECURRENCE-ID:20300102T100000Z','DTSTART:20300102T100000Z','DTEND:20300102T110000Z','STATUS:CANCELLED'),
  ))]);
  assert.deepEqual(starts(r),['2030-01-01T10:00:00.000Z']);
 });

 test('reports all-day events as all-day without flagging them',async()=> {
  const r=await list([obj('day.ics',ics(vevent('UID:d','DTSTART;VALUE=DATE:20300103','DTEND;VALUE=DATE:20300104','SUMMARY:Day')))]);
  assert.equal(r.body.occurrences[0].allDay,true);
  assert.equal(r.body.capped,false);
 });

 test('uses a timezone defined inside the event',async()=> {
  const r=await list([obj('zoned.ics',ics(
   'BEGIN:VTIMEZONE','TZID:Test/Plus2','BEGIN:STANDARD','DTSTART:19700101T000000','TZOFFSETFROM:+0200','TZOFFSETTO:+0200','END:STANDARD','END:VTIMEZONE',
   vevent('UID:z','DTSTART;TZID=Test/Plus2:20300103T120000','DTEND;TZID=Test/Plus2:20300103T130000','SUMMARY:Zoned'),
  ))]);
  assert.deepEqual(starts(r),['2030-01-03T10:00:00.000Z']);
  assert.equal(r.body.capped,false);
 });

 // capped:true tells the assistant not to treat the result as proof you're free.
 describe('flags results that may be incomplete or ambiguous',()=> {
  test('an event saved without a timezone',async()=> {
   assert.equal((await list([obj('f.ics',ics(vevent('UID:f','DTSTART:20300103T100000','DTEND:20300103T110000')))])).body.capped,true);
  });

  test('an event naming a timezone it does not define',async()=> {
   assert.equal((await list([obj('u.ics',ics(vevent('UID:u','DTSTART;TZID=Nowhere/Unknown:20300103T100000','DTEND;TZID=Nowhere/Unknown:20300103T110000')))])).body.capped,true);
  });

  test('a resource holding only moved occurrences, which is skipped',async()=> {
   const r=await list([
    obj('orphan.ics',ics(vevent('UID:o','RECURRENCE-ID:20300102T100000Z','DTSTART:20300102T110000Z','DTEND:20300102T120000Z','SUMMARY:Moved'))),
    obj('plain.ics',ics(timed('p','20300103T100000Z','20300103T110000Z'))),
   ]);
   assert.equal(r.body.capped,true);
   assert.deepEqual(r.body.occurrences.map((o:any)=>o.resourceId),[CAL+'plain.ics']);
  });

  test('a repeating event that continues past the range, even if a later event is not repeating',async()=> {
   const r=await list([
    obj('weekly.ics',ics(timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=WEEKLY'))),
    obj('later.ics',ics(timed('l','20300120T100000Z','20300120T110000Z'))),
   ]);
   assert.equal(r.body.capped,true);
   assert.equal(r.body.occurrences.length,2);
  });

  test('a series that hits the iteration limit before reaching the range',async()=> {
   // Hourly from 2027 needs more than 20,000 steps to reach 2030.
   const r=await list([obj('hourly.ics',ics(timed('h','20270101T000000Z','20270101T003000Z','RRULE:FREQ=HOURLY')))]);
   assert.equal(r.body.capped,true);
   assert.equal(r.body.occurrences.length,0);
  });
 });

 test('accepts a range of exactly 90 days but not more, nor a backwards one',async()=> {
  assert.equal((await list([],{end:'2030-04-01T00:00:00Z'})).isError,false);
  assert.equal((await list([],{end:'2030-04-01T00:00:01Z'})).isError,true);
  assert.equal((await list([],{start:RANGE.end,end:RANGE.start})).isError,true);
  assert.equal((await list([],{end:RANGE.start})).isError,true);
 });

 test('accepts up to 250 resources and refuses more',async()=> {
  const many=(n:number)=>Array.from({length:n},(_,i)=>obj(`e${i}.ics`,ics(timed(`e${i}`,'20300103T100000Z','20300103T110000Z'))));
  assert.equal((await list(many(250))).isError,false);
  assert.equal((await list(many(251))).isError,true);
 });

 test('accepts up to 500 occurrences and refuses more',async()=> {
  const hourly=(count:number)=>[obj('hourly.ics',ics(timed('h','20300101T000000Z','20300101T003000Z',`RRULE:FREQ=HOURLY;COUNT=${count}`)))];
  const range={end:'2030-01-30T00:00:00Z'};
  assert.equal((await list(hourly(500),range)).body.occurrences.length,500);
  assert.equal((await list(hourly(501),range)).isError,true);
 });
});

describe('create_event',()=> {
 test('writes the requested event into the calendar without overwriting anything',async()=> {
  const {call,writes}=await tools();
  const r=await call('create_event',NEW);
  assert.equal(r.isError,false);
  assert.equal(writes.length,1);
  const [write]=writes;
  assert.equal(write.op,'create');
  assert.equal(write.headers!['If-None-Match'],'*');
  assert.match(write.url,new RegExp('^'+CAL+'[0-9a-f-]{36}\\.ics$'));
  const ev=only(write.data!);
  assert.equal(text(ev,'summary'),'Connector test');
  assert.equal(text(ev,'dtstart'),'2030-01-03T10:00:00Z');
  assert.equal(text(ev,'dtend'),'2030-01-03T10:30:00Z');
  assert.equal(text(ev,'location'),'Office');
  assert.equal(text(ev,'description'),'Notes');
  assert.equal(r.body.created,true);
  assert.equal(r.body.resourceId,write.url);
  assert.equal(r.body.uid,text(ev,'uid'));
  assert.equal(r.body.verification,'verified');
 });

 test('keeps text that looks like calendar syntax as plain text',async()=> {
  const {call,writes}=await tools();
  const title='Lunch; with Ann, Bob\r\nATTENDEE:mailto:attacker@example.test\r\nBEGIN:VALARM';
  await call('create_event',{...NEW,title,location:'Room 1; floor 2, east'});
  const ev=only(writes[0].data!);
  assert.equal(text(ev,'summary'),title);
  assert.equal(text(ev,'location'),'Room 1; floor 2, east');
  assert.equal(ev.hasProperty('attendee'),false);
  assert.equal(ev.getAllSubcomponents('valarm').length,0);
 });

 test('leaves out an empty location and description',async()=> {
  const {call,writes}=await tools();
  const {location,description,...bare}=NEW;
  await call('create_event',bare);
  const ev=only(writes[0].data!);
  assert.equal(ev.hasProperty('location'),false);
  assert.equal(ev.hasProperty('description'),false);
 });

 test('places the event inside a calendar whose address lacks a trailing slash',async()=> {
  const noSlash=CAL.slice(0,-1);
  const r=await (await tools([],ENV,OWNER,{calendars:[{url:noSlash,displayName:'Home'}]})).call('create_event',{...NEW,calendarId:noSlash});
  assert.match(r.body.resourceId,new RegExp('^'+CAL+'[0-9a-f-]{36}\\.ics$'));
  assert.equal(r.body.verification,'verified');
 });

 test('reports success as pending when the new event cannot be read back',async()=> {
  const r=await (await tools([],ENV,OWNER,{keepCreated:false})).call('create_event',NEW);
  assert.equal(r.isError,false);
  assert.equal(r.body.created,true);
  assert.equal(r.body.verification,'pending');
 });

 test('rejects an end at or before the start without writing',async()=> {
  const {call,writes}=await tools();
  assert.equal((await call('create_event',{...NEW,end:NEW.start})).isError,true);
  assert.deepEqual(writes,[]);
 });

 test('reports a write the server refuses as a failure',async()=> {
  for (const status of [403,412]) {
   const r=await (await tools([],ENV,OWNER,{writeStatus:status})).call('create_event',NEW);
   assert.equal(r.isError,true,String(status));
   assert.equal(r.body.created,undefined);
  }
 });
});

describe('update_event',()=> {
 const original=ics(timed('p','20300101T100000Z','20300101T110000Z','SEQUENCE:2','X-CUSTOM:keep me','LOCATION:Old','BEGIN:VALARM','ACTION:DISPLAY','TRIGGER:-PT15M','DESCRIPTION:Reminder','END:VALARM'));

 test('writes the changed fields to the same event, with its version, keeping everything else',async()=> {
  const {call,writes}=await tools([obj('plain.ics',original)]);
  const r=await call('update_event',edit(CAL+'plain.ics',{start:'2030-01-01T12:00:00Z',end:'2030-01-01T13:00:00Z',location:'Office',description:'Notes'}));
  assert.deepEqual(r.body,{updated:true,resourceId:CAL+'plain.ics'});
  assert.equal(writes.length,1);
  const [write]=writes;
  assert.deepEqual([write.op,write.url,write.etag],['update',CAL+'plain.ics','"1"']);
  const ev=only(write.data!);
  assert.equal(text(ev,'uid'),'p');
  assert.equal(text(ev,'summary'),'Renamed');
  assert.equal(text(ev,'dtstart'),'2030-01-01T12:00:00Z');
  assert.equal(text(ev,'dtend'),'2030-01-01T13:00:00Z');
  assert.equal(text(ev,'location'),'Office');
  assert.equal(text(ev,'description'),'Notes');
  assert.equal(ev.getFirstPropertyValue('sequence'),3);
  assert.equal(text(ev,'x-custom'),'keep me');
  assert.equal(ev.getAllSubcomponents('valarm').length,1);
 });

 test('changes only the fields it is given',async()=> {
  const {call,writes}=await tools([obj('plain.ics',original)]);
  await call('update_event',edit(CAL+'plain.ics'));
  const ev=only(writes[0].data!);
  assert.equal(text(ev,'summary'),'Renamed');
  assert.equal(text(ev,'dtstart'),'2030-01-01T10:00:00Z');
  assert.equal(text(ev,'location'),'Old');
  const {title,...noTitle}=edit(CAL+'plain.ics',{location:'New'});
  const second=await tools([obj('plain.ics',original)]);
  await second.call('update_event',noTitle);
  assert.equal(text(only(second.writes[0].data!),'summary'),'Test');
  assert.equal(text(only(second.writes[0].data!),'location'),'New');
 });

 test.each([
  ['a repeating event', timed('s','20300101T100000Z','20300101T110000Z','RRULE:FREQ=DAILY')],
  ['an all-day event', vevent('UID:d','DTSTART;VALUE=DATE:20300101','DTEND;VALUE=DATE:20300102','SUMMARY:Day')],
  ['an invitation with an organizer', INVITES.organizer],
  ['an invitation with only attendees', INVITES.attendee],
 ])('refuses to change %s',async(_case,component)=> {
  const {call,writes}=await tools([obj('e.ics',ics(component))]);
  assert.equal((await call('update_event',edit(CAL+'e.ics'))).isError,true);
  assert.deepEqual(writes,[]);
 });

 test('refuses to change an event that changed since it was read',async()=> {
  const {call,writes}=await tools([obj('plain.ics',original,'"2"')]);
  assert.equal((await call('update_event',edit(CAL+'plain.ics'))).isError,true);
  assert.deepEqual(writes,[]);
 });

 test('refuses an end at or before the start',async()=> {
  const {call,writes}=await tools([obj('plain.ics',original)]);
  assert.equal((await call('update_event',edit(CAL+'plain.ics',{end:'2030-01-01T09:00:00Z'}))).isError,true);
  assert.deepEqual(writes,[]);
 });

 test('refuses time changes to an event stored with a duration, but allows other edits',async()=> {
  const {call,writes}=await tools([obj('dur.ics',ics(vevent('UID:u','DTSTART:20300101T100000Z','DURATION:PT1H','SUMMARY:Test')))]);
  assert.equal((await call('update_event',edit(CAL+'dur.ics',{start:'2030-01-01T11:00:00Z'}))).isError,true);
  assert.deepEqual(writes,[]);
  assert.equal((await call('update_event',edit(CAL+'dur.ics'))).isError,false);
  assert.equal(text(only(writes[0].data!),'summary'),'Renamed');
 });

 test('reports a write the server refuses as a failure',async()=> {
  for (const status of [403,412]) {
   const r=await (await tools([obj('plain.ics',original)],ENV,OWNER,{writeStatus:status})).call('update_event',edit(CAL+'plain.ics'));
   assert.equal(r.isError,true,String(status));
   assert.equal(r.body.updated,undefined);
  }
 });
});

describe('delete_event',()=> {
 test('deletes a one-off event, sending its version',async()=> {
  const {call,writes}=await tools([obj('plain.ics',ics(timed('p','20300101T100000Z','20300101T110000Z')))]);
  const r=await call('delete_event',del(CAL+'plain.ics'));
  assert.deepEqual(r.body,{deleted:true,resourceId:CAL+'plain.ics'});
  assert.deepEqual(writes,[{op:'delete',url:CAL+'plain.ics',etag:'"1"'}]);
 });

 test('deletes a repeating series only with whole-series confirmation',async()=> {
  const {call,writes}=await tools([obj('series.ics',ics(timed('s','20300101T100000Z','20300101T110000Z','RRULE:FREQ=DAILY')))]);
  assert.equal((await call('delete_event',del(CAL+'series.ics'))).isError,true);
  assert.deepEqual(writes,[]);
  assert.equal((await call('delete_event',del(CAL+'series.ics',{confirmEntireSeries:true}))).isError,false);
  assert.deepEqual(writes,[{op:'delete',url:CAL+'series.ics',etag:'"1"'}]);
 });


 describe('one occurrence of a series',()=> {
  const WEEKLY=timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=WEEKLY','SEQUENCE:2');
  const LA=ics('BEGIN:VTIMEZONE','TZID:America/Los_Angeles','BEGIN:DAYLIGHT','TZOFFSETFROM:-0800','TZOFFSETTO:-0700','TZNAME:PDT','DTSTART:19700308T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','END:DAYLIGHT','BEGIN:STANDARD','TZOFFSETFROM:-0700','TZOFFSETTO:-0800','TZNAME:PST','DTSTART:19701101T020000','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','END:STANDARD','END:VTIMEZONE',
   vevent('UID:z','DTSTART;TZID=America/Los_Angeles:20301026T090000','DTEND;TZID=America/Los_Angeles:20301026T100000','SUMMARY:Swap','RRULE:FREQ=WEEKLY'));
  const run=async(data:string,occurrence:string,extra={})=> {
   const t=await tools([obj('s.ics',data)]);
   return {...t,r:await t.call('delete_event',del(CAL+'s.ics',{occurrence,...extra}))};
  };

  test('adds an EXDATE to the series and keeps the rest of the resource',async()=> {
   const {r,writes}=await run(ics(WEEKLY),'2030-01-15T10:00:00Z');
   assert.deepEqual(r.body,{cancelled:true,resourceId:CAL+'s.ics',occurrence:'2030-01-15T10:00:00Z'});
   assert.equal(writes.length,1);
   assert.equal(writes[0].op,'update');
   assert.equal(writes[0].etag,'"1"');
   const ev=only(writes[0].data!);
   assert.equal(text(ev,'exdate'),'2030-01-15T10:00:00Z');
   assert.equal(text(ev,'rrule'),'FREQ=WEEKLY');
   assert.equal(text(ev,'sequence'),'3');
   assert.equal(ev.getAllProperties('exdate').length,1);
  });

  test('keeps exclusions already on the series',async()=> {
   const {writes}=await run(ics(timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=WEEKLY','EXDATE:20300108T100000Z')),'2030-01-15T10:00:00Z');
   assert.deepEqual(only(writes[0].data!).getAllProperties('exdate').map(p=>String(p.getFirstValue())).sort(),['2030-01-08T10:00:00Z','2030-01-15T10:00:00Z']);
  });

  test('the cancelled occurrence is gone from list_events and the others stay',async()=> {
   const {writes}=await run(ics(WEEKLY),'2030-01-08T10:00:00Z');
   const t=await tools([obj('s.ics',writes[0].data!)]);
   const r=await t.call('list_events',{...RANGE,end:'2030-01-20T00:00:00Z'});
   assert.deepEqual(r.body.occurrences.map((o:any)=>o.start),['2030-01-01T10:00:00.000Z','2030-01-15T10:00:00.000Z']);
  });

  test('matches a zoned series by its local time and writes the exclusion in that zone, across the November DST change',async()=> {
   // 2030-10-26 09:00 PDT = 16:00Z; 2030-11-02 09:00 PDT = 16:00Z; 2030-11-09 09:00 PST = 17:00Z
   const {r,writes}=await run(LA,'2030-11-09T17:00:00Z');
   assert.equal(r.isError,false);
   const ex=only(writes[0].data!).getFirstProperty('exdate')!;
   assert.equal(ex.getParameter('tzid'),'America/Los_Angeles');
   assert.equal(String(ex.getFirstValue()),'2030-11-09T09:00:00');
   assert.equal(writes[0].data!.includes('BEGIN:VTIMEZONE'),true);
   // the wall-clock time before the change is not an occurrence after it
   assert.equal((await run(LA,'2030-11-09T16:00:00Z')).r.isError,true);
  });

  test('writes an all-day series exclusion as a DATE',async()=> {
   const data=ics(vevent('UID:d','DTSTART;VALUE=DATE:20300101','DTEND;VALUE=DATE:20300102','SUMMARY:Day','RRULE:FREQ=DAILY'));
   const {r,writes}=await run(data,'2030-01-03T00:00:00Z');
   assert.equal(r.isError,false);
   assert.match(writes[0].data!,/EXDATE;VALUE=DATE:20300103/);
  });

  test('refuses a time the series does not generate',async()=> {
   for (const when of ['2030-01-02T10:00:00Z','2030-01-15T10:30:00Z','2029-12-25T10:00:00Z']) {
    const {r,writes}=await run(ics(WEEKLY),when);
    assert.equal(r.isError,true,when);
    assert.deepEqual(writes,[]);
   }
  });

  test('refuses an occurrence that is already cancelled',async()=> {
   const {r,writes}=await run(ics(timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=WEEKLY','EXDATE:20300108T100000Z')),'2030-01-08T10:00:00Z');
   assert.equal(r.isError,true);
   assert.deepEqual(writes,[]);
  });

  test('refuses an occurrence that has its own edited copy',async()=> {
   const data=ics(WEEKLY,vevent('UID:w','RECURRENCE-ID:20300108T100000Z','DTSTART:20300108T120000Z','DTEND:20300108T130000Z','SUMMARY:Moved'));
   const {r,writes}=await run(data,'2030-01-08T10:00:00Z');
   assert.equal(r.isError,true);
   assert.deepEqual(writes,[]);
   // other occurrences of the same resource can still be cancelled, and the copy is kept
   const other=await run(data,'2030-01-15T10:00:00Z');
   assert.equal(other.r.isError,false);
   assert.equal(parse(other.writes[0].data!).getAllSubcomponents('vevent').length,2);
  });

  test('refuses things that are not a plain series',async()=> {
   const cases:[string,string][]=[
    ['a one-off event',ics(timed('p','20300101T100000Z','20300101T110000Z'))],
    ['a resource with only edited copies',ics(vevent('UID:o','RECURRENCE-ID:20300108T100000Z','DTSTART:20300108T100000Z','DTEND:20300108T110000Z','SUMMARY:x'))],
    ['an invitation',ics(timed('i','20300101T100000Z','20300101T110000Z','RRULE:FREQ=WEEKLY','ORGANIZER:mailto:a@example.test'))],
   ];
   for (const [name,data] of cases) {
    const {r,writes}=await run(data,'2030-01-08T10:00:00Z');
    assert.equal(r.isError,true,name);
    assert.deepEqual(writes,[],name);
   }
  });

  test('refuses an occurrence that is too far into the series to find',async()=> {
   const {r,writes}=await run(ics(timed('m','20300101T100000Z','20300101T100100Z','RRULE:FREQ=MINUTELY')),'2031-01-01T10:00:00Z');
   assert.equal(r.isError,true);
   assert.deepEqual(writes,[]);
  });

  test('refuses to combine one occurrence with the entire series',async()=> {
   const {r,writes}=await run(ics(WEEKLY),'2030-01-08T10:00:00Z',{confirmEntireSeries:true});
   assert.equal(r.isError,true);
   assert.deepEqual(writes,[]);
  });

  test('needs the current version and confirmation',async()=> {
   const t=await tools([obj('s.ics',ics(WEEKLY),'"2"')]);
   assert.equal((await t.call('delete_event',del(CAL+'s.ics',{occurrence:'2030-01-08T10:00:00Z'}))).isError,true);
   assert.deepEqual(t.writes,[]);
   assert.throws(()=>t.registered.delete_event.config.inputSchema.parse({calendarId:CAL,resourceId:CAL+'s.ics',etag:'"2"',occurrence:'2030-01-08T10:00:00Z'}));
  });

  test('reports a refused save as a failure',async()=> {
   const t=await tools([obj('s.ics',ics(WEEKLY))],ENV,OWNER,{writeStatus:412});
   const r=await t.call('delete_event',del(CAL+'s.ics',{occurrence:'2030-01-08T10:00:00Z'}));
   assert.equal(r.isError,true);
   assert.equal(r.body.cancelled,undefined);
  });
 });

 test.each([['an organizer','organizer'],['only attendees','attendee']] as const)('refuses to delete an invitation with %s',async(_case,kind)=> {
  const {call,writes}=await tools([obj('i.ics',ics(INVITES[kind]))]);
  assert.equal((await call('delete_event',del(CAL+'i.ics',{confirmEntireSeries:true}))).isError,true);
  assert.deepEqual(writes,[]);
 });

 test('refuses to delete an event that changed since it was read',async()=> {
  const {call,writes}=await tools([obj('plain.ics',ics(timed('p','20300101T100000Z','20300101T110000Z')),'"2"')]);
  assert.equal((await call('delete_event',del(CAL+'plain.ics'))).isError,true);
  assert.deepEqual(writes,[]);
 });

 test('reports a delete the server refuses as a failure',async()=> {
  for (const status of [403,412]) {
   const r=await (await tools([obj('plain.ics',ics(timed('p','20300101T100000Z','20300101T110000Z')))],ENV,OWNER,{writeStatus:status})).call('delete_event',del(CAL+'plain.ics'));
   assert.equal(r.isError,true,String(status));
   assert.equal(r.body.deleted,undefined);
  }
 });
});

describe('calendar boundary in the tools',()=> {
 const WORK='https://calendar.example.test/1/calendars/work/';
 const outside={url:WORK+'x.ics',etag:'"1"',data:ics(timed('x','20300101T100000Z','20300101T110000Z'))};

 test('no tool reads or changes an event outside the chosen calendar',async()=> {
  const {call,writes}=await tools([outside]);
  assert.equal((await call('get_event',{calendarId:CAL,resourceId:outside.url})).isError,true);
  assert.equal((await call('update_event',edit(outside.url))).isError,true);
  assert.equal((await call('delete_event',del(outside.url))).isError,true);
  assert.deepEqual(writes,[]);
 });

 test('no tool uses a calendar the account does not have',async()=> {
  const {call,writes}=await tools([outside]);
  assert.equal((await call('list_events',{...RANGE,calendarId:WORK})).isError,true);
  assert.equal((await call('create_event',{...NEW,calendarId:WORK})).isError,true);
  assert.equal((await call('get_event',{calendarId:WORK,resourceId:outside.url})).isError,true);
  assert.deepEqual(writes,[]);
 });

 test('refuses when the server answers with a different event than the one asked for',async()=> {
  for (const answer of [[outside],[{...outside,url:CAL+'other.ics'}],[obj('a.ics',outside.data),obj('a.ics',outside.data)],[]]) {
   const {call,writes}=await tools([],ENV,OWNER,{fetchObjects:()=>answer});
   assert.equal((await call('get_event',{calendarId:CAL,resourceId:CAL+'a.ics'})).isError,true);
   assert.equal((await call('delete_event',del(CAL+'a.ics'))).isError,true);
   assert.deepEqual(writes,[]);
  }
 });

 test('accepts the server escaping characters in the event address',async()=> {
  const data=ics(timed('a','20300101T100000Z','20300101T110000Z'));
  const {call}=await tools([],ENV,OWNER,{fetchObjects:()=>[{url:CAL+'a%40b.ics',etag:'"1"',data}]});
  assert.equal((await call('get_event',{calendarId:CAL,resourceId:CAL+'a@b.ics'})).isError,false);
 });
});
