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

 test('our own explanations of what to change are passed on, other RangeErrors are not',async()=> {
  const own=await tools([obj('i.ics',ics(INVITES.organizer))]);
  const refused=await own.call('update_event',edit(CAL+'i.ics'));
  assert.equal(refused.isError,true);
  assert.match(refused.body.error,/confirmGuests: "NOTIFY GUESTS"/);
  assert.equal(refused.body.reason,'RequestError');
  const foreign=await (await failingWith(new RangeError('Invalid URL https://user:hunter2@calendar.example.test'))).call('list_calendars',{});
  assert.deepEqual(foreign.body,{error:'CalDAV operation failed',reason:'RangeError'});
 });

 test('a stale version and a refused save say what to do',async()=> {
  const stale=await (await tools([obj('p.ics',ics(timed('p','20300101T100000Z','20300101T110000Z')),'"2"')])).call('update_event',edit(CAL+'p.ics'));
  assert.match(stale.body.error,/read again/);
  const conflict=await (await tools([obj('p.ics',ics(timed('p','20300101T100000Z','20300101T110000Z')))],ENV,OWNER,{writeStatus:412})).call('update_event',edit(CAL+'p.ics'));
  assert.match(conflict.body.error,/^Conflict: .*read it again/);
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

describe('create_event: all-day, repeating and timezones',()=> {
 const LA='America/Los_Angeles';
 const created=async(args:Record<string,unknown>)=> {
  const t=await tools();
  const r=await t.call('create_event',{...NEW,...args});
  return {...t,r,ev:r.isError?undefined:only(t.writes[0].data!)};
 };
 // the clock time an instant has in a zone, as hh:mm
 const clock=(tz:string,iso:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));

 test('creates an all-day event from dates, the end being the last day',async()=> {
  const a=await created({start:'2030-01-05',end:undefined});
  assert.equal(a.r.isError,false);
  assert.match(a.writes[0].data!,/DTSTART;VALUE=DATE:20300105/);
  assert.match(a.writes[0].data!,/DTEND;VALUE=DATE:20300106/);
  const b=await created({start:'2030-01-05',end:'2030-01-07'});
  assert.match(b.writes[0].data!,/DTEND;VALUE=DATE:20300108/);
 });

 test.each([
  ['a date start with a date-time end',{start:'2030-01-05',end:'2030-01-05T10:00:00Z'}],
  ['a date-time start with a date end',{end:'2030-01-05'}],
  ['a timed event with no end',{end:undefined}],
  ['an all-day end before its start',{start:'2030-01-05',end:'2030-01-04'}],
  ['an unknown timezone',{timezone:'Mars/Olympus'}],
  ['a rule that does not parse',{rrule:'FREQ=SOMETIMES'}],
 ])('rejects %s without writing',async(_name,args)=> {
  const {r,writes}=await created(args);
  assert.equal(r.isError,true);
  assert.deepEqual(writes,[]);
 });

 test('only accepts a repeat rule made of rule characters',async()=> {
  const {registered}=await tools();
  assert.throws(()=>registered.create_event.config.inputSchema.parse({...NEW,rrule:'FREQ=WEEKLY; DROP'}));
 });

 test('creates a repeating event and says so when no timezone was given',async()=> {
  const a=await created({rrule:'FREQ=WEEKLY;BYDAY=TH'});
  assert.equal(a.r.isError,false);
  assert.equal(text(a.ev!,'rrule'),'FREQ=WEEKLY;BYDAY=TH');
  assert.match(a.r.body.note,/shift by an hour/);
  const b=await created({rrule:'FREQ=WEEKLY;BYDAY=TH',timezone:LA});
  assert.equal(b.r.body.note,undefined);
  const c=await created({start:'2030-01-05',rrule:'FREQ=DAILY'});
  assert.equal(c.r.body.note,undefined);
  const d=await created({});
  assert.equal(d.r.body.note,undefined);
 });

 test('timezone UTC needs no timezone definition',async()=> {
  const {writes}=await created({timezone:'UTC',rrule:'FREQ=DAILY'});
  assert.equal(writes[0].data!.includes('VTIMEZONE'),false);
  assert.equal(text(only(writes[0].data!),'dtstart'),'2030-01-03T10:00:00Z');
 });

 test('writes a timed event in its timezone, with that zone defined in the same resource',async()=> {
  const {writes}=await created({start:'2030-07-03T16:00:00Z',end:'2030-07-03T17:30:00Z',timezone:LA});
  const ev=only(writes[0].data!);
  assert.equal(ev.getFirstProperty('dtstart')!.getParameter('tzid'),LA);
  assert.equal(String(ev.getFirstPropertyValue('dtstart')),'2030-07-03T09:00:00');
  assert.equal(String(ev.getFirstPropertyValue('dtend')),'2030-07-03T10:30:00');
  assert.equal(parse(writes[0].data!).getFirstSubcomponent('vtimezone')!.getFirstPropertyValue('tzid'),LA);
  assert.equal(ev.getFirstPropertyValue('dtstart').toJSDate().toISOString(),'2030-07-03T16:00:00.000Z');
  // summer time is declared as DAYLIGHT (-0700) and winter time as STANDARD (-0800)
  const zone=parse(writes[0].data!).getFirstSubcomponent('vtimezone')!;
  const kinds=(name:string)=>new Set(zone.getAllSubcomponents(name).map(o=>String(o.getFirstPropertyValue('tzoffsetto'))));
  assert.deepEqual([...kinds('daylight')],['-07:00']);
  assert.deepEqual([...kinds('standard')].sort(),['-08:00']);
 });

 test.each([
  ['America/Los_Angeles','2030-03-01T17:00:00Z','2030-03-01T18:00:00Z'],
  ['Europe/London','2030-03-20T09:00:00Z','2030-03-20T10:00:00Z'],
  ['Australia/Lord_Howe','2030-04-01T00:00:00Z','2030-04-01T01:00:00Z'],
  ['Asia/Kolkata','2030-03-01T04:30:00Z','2030-03-01T05:30:00Z'],
  ['America/Sao_Paulo','2030-03-01T15:00:00Z','2030-03-01T16:00:00Z'],
 ])('a weekly event in %s stays at the same local time through daylight-saving changes',async(tz,start,end)=> {
  const made=await created({start,end,timezone:tz,rrule:'FREQ=WEEKLY'});
  assert.equal(made.r.isError,false);
  const expected=clock(tz,start);
  const t=await tools([obj('s.ics',made.writes[0].data!)]);
  const l=await t.call('list_events',{calendarId:CAL,start:new Date(Date.parse(start)-86400000).toISOString(),end:new Date(Date.parse(start)+85*86400000).toISOString()});
  assert.equal(l.body.occurrences.length>=12,true);
  for (const o of l.body.occurrences) assert.equal(clock(tz,o.start),expected,o.start);
 });
});

describe('update_event on a whole series',()=> {
 const LA=(...extra:string[])=>ics('BEGIN:VTIMEZONE','TZID:America/Los_Angeles','BEGIN:DAYLIGHT','TZOFFSETFROM:-0800','TZOFFSETTO:-0700','TZNAME:PDT','DTSTART:19700308T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','END:DAYLIGHT','BEGIN:STANDARD','TZOFFSETFROM:-0700','TZOFFSETTO:-0800','TZNAME:PST','DTSTART:19701101T020000','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','END:STANDARD','END:VTIMEZONE',
  vevent('UID:z','DTSTART;TZID=America/Los_Angeles:20301026T090000','DTEND;TZID=America/Los_Angeles:20301026T100000','SUMMARY:Swap','RRULE:FREQ=WEEKLY',...extra));
 const week=(...extra:string[])=>ics(vevent('UID:w','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:Weekly','LOCATION:Hall','RRULE:FREQ=WEEKLY',...extra));
 const events=(data:string)=>parse(data).getAllSubcomponents('vevent');
 const whole=async(data:string,args:Record<string,unknown>={})=> {
  const t=await tools([obj('s.ics',data)]);
  return {...t,r:await t.call('update_event',edit(CAL+'s.ics',{scope:'entireSeries',...args}))};
 };

 test('changes the text of every occurrence and leaves edited occurrences alone',async()=> {
  const copy=vevent('UID:w','RECURRENCE-ID:20300108T100000Z','DTSTART:20300108T120000Z','DTEND:20300108T130000Z','SUMMARY:Special');
  const {r,writes}=await whole(ics(vevent('UID:w','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:Weekly','RRULE:FREQ=WEEKLY'),copy),{location:'Room 2',description:'Notes'});
  assert.deepEqual(r.body,{updated:true,resourceId:CAL+'s.ics',scope:'entireSeries'});
  assert.equal(writes.length,1);
  assert.equal(writes[0].etag,'"1"');
  const [master,other]=events(writes[0].data!);
  assert.equal(text(master,'summary'),'Renamed');
  assert.equal(text(master,'location'),'Room 2');
  assert.equal(text(master,'description'),'Notes');
  assert.equal(text(master,'sequence'),'1');
  assert.equal(text(other,'summary'),'Special');
 });

 test('changes the time of day in the series zone, across the November change',async()=> {
  // a week at 9:00 local, moved to 10:00 local: 17:00Z in winter
  const {writes}=await whole(LA('EXDATE;TZID=America/Los_Angeles:20301109T090000'),{title:undefined,start:'2030-10-26T17:00:00Z',end:'2030-10-26T18:30:00Z'});
  const ev=only(writes[0].data!);
  assert.equal(String(ev.getFirstPropertyValue('dtstart')),'2030-10-26T10:00:00');
  assert.equal(String(ev.getFirstPropertyValue('dtend')),'2030-10-26T11:30:00');
  assert.equal(ev.getFirstProperty('dtstart')!.getParameter('tzid'),'America/Los_Angeles');
  assert.equal(String(ev.getFirstPropertyValue('exdate')),'2030-11-09T10:00:00');
  const t=await tools([obj('s.ics',writes[0].data!)]);
  const l=await t.call('list_events',{calendarId:CAL,start:'2030-10-25T00:00:00Z',end:'2030-11-25T00:00:00Z'});
  assert.deepEqual(l.body.occurrences.map((o:any)=>o.start),['2030-10-26T17:00:00.000Z','2030-11-02T17:00:00.000Z','2030-11-16T18:00:00.000Z','2030-11-23T18:00:00.000Z']);
 });

 test('moving the start moves cancelled dates, extra dates and the keys of edited occurrences with it',async()=> {
  const copy=vevent('UID:w','RECURRENCE-ID:20300115T100000Z','DTSTART:20300115T100000Z','DTEND:20300115T110000Z','SUMMARY:Special');
  const data=ics(vevent('UID:w','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:W','RRULE:FREQ=WEEKLY','EXDATE:20300108T100000Z','RDATE:20300103T100000Z'),copy);
  const {writes}=await whole(data,{start:'2030-01-01T12:00:00Z'});
  const [master,other]=events(writes[0].data!);
  assert.equal(text(master,'exdate'),'2030-01-08T12:00:00Z');
  assert.equal(text(master,'rdate'),'2030-01-03T12:00:00Z');
  assert.equal(text(other,'recurrence-id'),'2030-01-15T12:00:00Z');
  assert.equal(text(other,'dtstart'),'2030-01-15T10:00:00Z');
 });

 test('moves an all-day series by whole days',async()=> {
  const data=ics(vevent('UID:a','DTSTART;VALUE=DATE:20300101','DTEND;VALUE=DATE:20300102','SUMMARY:A','RRULE:FREQ=DAILY','EXDATE;VALUE=DATE:20300103'));
  const {writes}=await whole(data,{start:'2030-01-05'});
  assert.match(writes[0].data!,/DTSTART;VALUE=DATE:20300105/);
  assert.match(writes[0].data!,/EXDATE;VALUE=DATE:20300107/);
 });

 test('changes how the series repeats',async()=> {
  const {writes}=await whole(week(),{rrule:'FREQ=WEEKLY;INTERVAL=2'});
  assert.equal(text(only(writes[0].data!),'rrule'),'FREQ=WEEKLY;INTERVAL=2');
  const t=await tools([obj('s.ics',writes[0].data!)]);
  const l=await t.call('list_events',{...RANGE,end:'2030-01-30T00:00:00Z'});
  assert.deepEqual(l.body.occurrences.map((o:any)=>o.start),['2030-01-01T10:00:00.000Z','2030-01-15T10:00:00.000Z','2030-01-29T10:00:00.000Z']);
 });

 test('moves a series to another day, and a fixed-day series only with a new rule',async()=> {
  const a=await whole(week(),{start:'2030-01-02T10:00:00Z'});
  assert.equal(a.r.isError,false);
  assert.equal(text(only(a.writes[0].data!),'dtstart'),'2030-01-02T10:00:00Z');
  const tuesdays=ics(vevent('UID:w','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:W','RRULE:FREQ=WEEKLY;BYDAY=TU'));
  const b=await whole(tuesdays,{start:'2030-01-02T10:00:00Z'});
  assert.equal(b.r.isError,true);
  assert.deepEqual(b.writes,[]);
  const c=await whole(tuesdays,{start:'2030-01-02T10:00:00Z',rrule:'FREQ=WEEKLY;BYDAY=WE'});
  assert.equal(c.r.isError,false);
  assert.equal(text(only(c.writes[0].data!),'rrule'),'FREQ=WEEKLY;BYDAY=WE');
 });

 test('edits a series made only of extra dates',async()=> {
  const data=ics(vevent('UID:r','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:R','RDATE:20300108T100000Z'));
  const {r,writes}=await whole(data);
  assert.equal(r.isError,false);
  assert.equal(text(only(writes[0].data!),'summary'),'Renamed');
 });

 test.each([
  ['an occurrence together with entireSeries',week(),{occurrence:'2030-01-08T10:00:00Z'}],
  ['an edit that changes nothing',week(),{title:undefined}],
  ['a resource with only edited occurrences',ics(vevent('UID:o','RECURRENCE-ID:20300108T100000Z','DTSTART:20300108T100000Z','DTEND:20300108T110000Z','SUMMARY:x')),{}],
  ['an end before the start',week(),{end:'2030-01-01T09:00:00Z'}],
 ])('does not accept %s',async(_name,data,args)=> {
  const {r,writes}=await whole(data,args);
  assert.equal(r.isError,true);
  assert.deepEqual(writes,[]);
 });

 test('needs a scope for a repeating event and an occurrence for the other scopes',async()=> {
  const t=await tools([obj('s.ics',week())]);
  assert.equal((await t.call('update_event',edit(CAL+'s.ics'))).isError,true);
  assert.equal((await t.call('update_event',edit(CAL+'s.ics',{scope:'thisAndFollowing'}))).isError,true);
  assert.deepEqual(t.writes,[]);
 });

 test('an occurrence cannot be addressed on an event that does not repeat, and other resources are not events',async()=> {
  const t=await tools([obj('p.ics',ics(timed('p','20300101T100000Z','20300101T110000Z'))),obj('todo.ics',ics('BEGIN:VTODO','UID:t','SUMMARY:x','END:VTODO'))]);
  assert.equal((await t.call('update_event',edit(CAL+'p.ics',{occurrence:'2030-01-01T10:00:00Z'}))).isError,true);
  assert.equal((await t.call('update_event',edit(CAL+'todo.ics'))).isError,true);
  assert.deepEqual(t.writes,[]);
 });

 test('changing or deleting a series with guests takes the confirmation, and then works',async()=> {
  const guests=week('ORGANIZER:mailto:a@example.test');
  const t=await tools([obj('s.ics',guests)]);
  assert.equal((await t.call('update_event',edit(CAL+'s.ics',{scope:'entireSeries'}))).isError,true);
  assert.equal((await t.call('delete_event',del(CAL+'s.ics',{confirmEntireSeries:true}))).isError,true);
  assert.deepEqual(t.writes,[]);
  assert.equal((await t.call('update_event',edit(CAL+'s.ics',{scope:'entireSeries',confirmGuests:'NOTIFY GUESTS'}))).isError,false);
  assert.equal((await t.call('delete_event',del(CAL+'s.ics',{confirmEntireSeries:true,confirmGuests:'NOTIFY GUESTS'}))).isError,false);
  assert.deepEqual(t.writes.map(w=>w.op),['update','delete']);
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
  ['an invitation with an organizer', INVITES.organizer],
  ['an invitation with only attendees', INVITES.attendee],
 ])('does not change %s without the matching confirmation',async(_case,component)=> {
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

 test('moves an event stored with a duration, keeping the duration, or swaps it for an end',async()=> {
  const dur=ics(vevent('UID:u','DTSTART:20300101T100000Z','DURATION:PT1H','SUMMARY:Test'));
  const a=await tools([obj('dur.ics',dur)]);
  assert.equal((await a.call('update_event',edit(CAL+'dur.ics',{start:'2030-01-01T11:00:00Z'}))).isError,false);
  const moved=only(a.writes[0].data!);
  assert.equal(text(moved,'dtstart'),'2030-01-01T11:00:00Z');
  assert.equal(text(moved,'duration'),'PT1H');
  assert.equal(moved.hasProperty('dtend'),false);
  const b=await tools([obj('dur.ics',dur)]);
  assert.equal((await b.call('update_event',edit(CAL+'dur.ics',{end:'2030-01-01T12:00:00Z'}))).isError,false);
  const ended=only(b.writes[0].data!);
  assert.equal(ended.hasProperty('duration'),false);
  assert.equal(text(ended,'dtend'),'2030-01-01T12:00:00Z');
  const c=await tools([obj('dur.ics',dur)]);
  assert.equal((await c.call('update_event',edit(CAL+'dur.ics'))).isError,false);
  assert.equal(text(only(c.writes[0].data!),'summary'),'Renamed');
 });

 describe('all-day events',()=> {
  const DAY=ics(vevent('UID:d','DTSTART;VALUE=DATE:20300101','DTEND;VALUE=DATE:20300103','SUMMARY:Trip'));
  test('changes the title and moves the dates, keeping the length',async()=> {
   const {call,writes}=await tools([obj('d.ics',DAY)]);
   const r=await call('update_event',edit(CAL+'d.ics',{start:'2030-02-10'}));
   assert.equal(r.isError,false);
   const ev=only(writes[0].data!);
   assert.equal(text(ev,'summary'),'Renamed');
   assert.match(writes[0].data!,/DTSTART;VALUE=DATE:20300210/);
   assert.match(writes[0].data!,/DTEND;VALUE=DATE:20300212/);
  });
  test('takes the last day as the end, inclusive',async()=> {
   const {call,writes}=await tools([obj('d.ics',DAY)]);
   await call('update_event',edit(CAL+'d.ics',{end:'2030-01-05'}));
   assert.match(writes[0].data!,/DTSTART;VALUE=DATE:20300101/);
   assert.match(writes[0].data!,/DTEND;VALUE=DATE:20300106/);
  });
  test('needs dates for an all-day event and a date-time for a timed one',async()=> {
   const t=await tools([obj('d.ics',DAY),obj('p.ics',ics(timed('p','20300101T100000Z','20300101T110000Z')))]);
   assert.equal((await t.call('update_event',edit(CAL+'d.ics',{start:'2030-02-10T10:00:00Z'}))).isError,true);
   assert.equal((await t.call('update_event',edit(CAL+'p.ics',{start:'2030-02-10'}))).isError,true);
   assert.deepEqual(t.writes,[]);
  });
 });

 describe('guests',()=> {
  test('can be changed once confirmed',async()=> {
   const {call,writes}=await tools([obj('i.ics',ics(INVITES.organizer))]);
   assert.equal((await call('update_event',edit(CAL+'i.ics'))).isError,true);
   assert.deepEqual(writes,[]);
   assert.equal((await call('update_event',edit(CAL+'i.ics',{confirmGuests:'NOTIFY GUESTS'}))).isError,false);
   assert.equal(writes.length,1);
  });
  test('the confirmation has to be the exact words',async()=> {
   const {registered}=await tools();
   assert.throws(()=>registered.update_event.config.inputSchema.parse(edit(CAL+'i.ics',{confirmGuests:true})));
   assert.throws(()=>registered.delete_event.config.inputSchema.parse(del(CAL+'i.ics',{confirmGuests:'yes'})));
  });
 });

 describe('making an event repeat, or changing how it repeats',()=> {
  test('adds a repeat rule to a one-off event',async()=> {
   const {call,writes}=await tools([obj('plain.ics',original)]);
   const r=await call('update_event',edit(CAL+'plain.ics',{rrule:'FREQ=WEEKLY;COUNT=4'}));
   assert.equal(r.isError,false);
   assert.equal(text(only(writes[0].data!),'rrule'),'FREQ=WEEKLY;COUNT=4');
  });
  test.each([['garbage'],['FREQ=HOURLY'],['FREQ=WEEKLY;COUNT=3;UNTIL=20300301T000000Z']])('rejects the rule %s',async(rule)=> {
   const {call,writes}=await tools([obj('plain.ics',original)]);
   assert.equal((await call('update_event',edit(CAL+'plain.ics',{rrule:rule}))).isError,true);
   assert.deepEqual(writes,[]);
  });
  test('an edit that changes nothing is not written',async()=> {
   const {call,writes}=await tools([obj('plain.ics',original)]);
   assert.equal((await call('update_event',edit(CAL+'plain.ics',{title:undefined}))).isError,true);
   assert.deepEqual(writes,[]);
  });
  test('accepts a rule written with its RRULE: prefix',async()=> {
   const {call,writes}=await tools([obj('plain.ics',original)]);
   assert.equal((await call('update_event',edit(CAL+'plain.ics',{rrule:'RRULE:FREQ=DAILY'}))).isError,false);
   assert.equal(text(only(writes[0].data!),'rrule'),'FREQ=DAILY');
  });
 });

 test('reports a write the server refuses as a failure',async()=> {
  for (const status of [403,412]) {
   const r=await (await tools([obj('plain.ics',original)],ENV,OWNER,{writeStatus:status})).call('update_event',edit(CAL+'plain.ics'));
   assert.equal(r.isError,true,String(status));
   assert.equal(r.body.updated,undefined);
  }
 });
});

describe('update_event on a one-off event in a saved timezone',()=> {
 test('writes moved times in UTC without the old TZID',async()=> {
  const data=ics(vevent('UID:z','DTSTART;TZID=America/Los_Angeles:20301026T090000','DTEND;TZID=America/Los_Angeles:20301026T100000','SUMMARY:Z'));
  const {call,writes}=await tools([obj('z.ics',data)]);
  const r=await call('update_event',edit(CAL+'z.ics',{start:'2030-10-26T18:00:00Z',end:'2030-10-26T19:00:00Z'}));
  assert.equal(r.isError,false);
  const ev=only(writes[0].data!);
  assert.equal(ev.getFirstProperty('dtstart')!.toICALString(),'DTSTART:20301026T180000Z');
  assert.equal(ev.getFirstProperty('dtend')!.toICALString(),'DTEND:20301026T190000Z');
 });
});

describe('update_event on one occurrence of a series',()=> {
 const WEEKLY=timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=WEEKLY','LOCATION:Hall','DESCRIPTION:Keep','BEGIN:VALARM','ACTION:DISPLAY','TRIGGER:-PT10M','DESCRIPTION:Alarm','END:VALARM');
 const LA=ics('BEGIN:VTIMEZONE','TZID:America/Los_Angeles','BEGIN:DAYLIGHT','TZOFFSETFROM:-0800','TZOFFSETTO:-0700','TZNAME:PDT','DTSTART:19700308T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','END:DAYLIGHT','BEGIN:STANDARD','TZOFFSETFROM:-0700','TZOFFSETTO:-0800','TZNAME:PST','DTSTART:19701101T020000','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','END:STANDARD','END:VTIMEZONE',
  vevent('UID:z','DTSTART;TZID=America/Los_Angeles:20301026T090000','DTEND;TZID=America/Los_Angeles:20301026T100000','SUMMARY:Swap','RRULE:FREQ=WEEKLY'));
 const OVERRIDE=vevent('UID:w','RECURRENCE-ID:20300108T100000Z','DTSTART:20300108T120000Z','DTEND:20300108T130000Z','SUMMARY:Moved','SEQUENCE:4');
 const run=async(data:string,args:Record<string,unknown>,etag='"1"')=> {
  const t=await tools([obj('s.ics',data,etag)]);
  return {...t,r:await t.call('update_event',edit(CAL+'s.ics',{title:undefined,occurrence:'2030-01-08T10:00:00Z',...args}))};
 };
 const events=(data:string)=>parse(data).getAllSubcomponents('vevent');

 test('adds an override for the occurrence and leaves the series as it was',async()=> {
  const {r,writes}=await run(ics(WEEKLY),{title:'One-off name'});
  assert.deepEqual(r.body,{updated:true,resourceId:CAL+'s.ics',occurrence:'2030-01-08T10:00:00Z'});
  assert.equal(writes.length,1);
  assert.equal(writes[0].etag,'"1"');
  const [master,override]=events(writes[0].data!);
  assert.equal(text(master,'summary'),'Test');
  assert.equal(text(master,'rrule'),'FREQ=WEEKLY');
  assert.equal(master.hasProperty('recurrence-id'),false);
  assert.equal(master.hasProperty('exdate'),false);
  assert.equal(text(override,'uid'),'w');
  assert.equal(text(override,'recurrence-id'),'2030-01-08T10:00:00Z');
  assert.equal(text(override,'dtstart'),'2030-01-08T10:00:00Z');
  assert.equal(text(override,'dtend'),'2030-01-08T11:00:00Z');
  assert.equal(text(override,'summary'),'One-off name');
  assert.equal(text(override,'location'),'Hall');
  assert.equal(override.hasProperty('rrule'),false);
  assert.equal(override.getAllSubcomponents('valarm').length,1);
  assert.equal(text(override,'sequence'),'1');
 });

 test('changes time, location and description, and moving the start alone keeps the length',async()=> {
  const a=await run(ics(WEEKLY),{start:'2030-01-08T14:00:00Z',location:'Room 2',description:'New'});
  const o=events(a.writes[0].data!)[1];
  assert.equal(text(o,'dtstart'),'2030-01-08T14:00:00Z');
  assert.equal(text(o,'dtend'),'2030-01-08T15:00:00Z');
  assert.equal(text(o,'location'),'Room 2');
  assert.equal(text(o,'description'),'New');
  const b=await run(ics(WEEKLY),{end:'2030-01-08T10:30:00Z'});
  assert.equal(text(events(b.writes[0].data!)[1],'dtend'),'2030-01-08T10:30:00Z');
 });

 test('updates an occurrence that already has an override instead of adding another',async()=> {
  const data=ics(WEEKLY,OVERRIDE);
  const {r,writes}=await run(data,{title:'Renamed again'});
  assert.equal(r.isError,false);
  const all=events(writes[0].data!);
  assert.equal(all.length,2);
  assert.equal(text(all[1],'summary'),'Renamed again');
  assert.equal(text(all[1],'dtstart'),'2030-01-08T12:00:00Z');
  assert.equal(text(all[1],'sequence'),'5');
  assert.equal(text(all[0],'summary'),'Test');
 });

 test('leaves other overrides untouched',async()=> {
  const other=vevent('UID:w','RECURRENCE-ID:20300115T100000Z','DTSTART:20300115T100000Z','DTEND:20300115T110000Z','SUMMARY:Other');
  const {writes}=await run(ics(WEEKLY,OVERRIDE,other),{title:'Changed'});
  const all=events(writes[0].data!);
  assert.equal(all.length,3);
  assert.equal(text(all[2],'summary'),'Other');
  assert.equal(text(all[1],'summary'),'Changed');
 });

 test('writes a zoned series occurrence in its own zone across the November daylight-saving change',async()=> {
  // 2030-11-09 09:00 PST = 17:00Z
  const {r,writes}=await run(LA,{title:'Moved swap',occurrence:'2030-11-09T17:00:00Z'});
  assert.equal(r.isError,false);
  const o=events(writes[0].data!)[1];
  assert.equal(o.getFirstProperty('recurrence-id')!.getParameter('tzid'),'America/Los_Angeles');
  assert.equal(String(o.getFirstPropertyValue('recurrence-id')),'2030-11-09T09:00:00');
  assert.equal(o.getFirstProperty('dtstart')!.getParameter('tzid'),'America/Los_Angeles');
  assert.equal(String(o.getFirstPropertyValue('dtend')),'2030-11-09T10:00:00');
  assert.equal((await run(LA,{title:'x',occurrence:'2030-11-09T16:00:00Z'})).r.isError,true);
 });

 test('a moved start or end is written in UTC without the series zone',async()=> {
  const {writes}=await run(LA,{start:'2030-11-09T19:00:00Z',occurrence:'2030-11-09T17:00:00Z'});
  const o=events(writes[0].data!)[1];
  assert.equal(o.getFirstProperty('dtstart')!.toICALString(),'DTSTART:20301109T190000Z');
  assert.equal(o.getFirstProperty('dtend')!.toICALString(),'DTEND:20301109T200000Z');
  assert.equal(o.getFirstProperty('recurrence-id')!.getParameter('tzid'),'America/Los_Angeles');
  const e=await run(LA,{end:'2030-11-09T19:30:00Z',occurrence:'2030-11-09T17:00:00Z'});
  assert.equal(events(e.writes[0].data!)[1].getFirstProperty('dtend')!.toICALString(),'DTEND:20301109T193000Z');
 });

 test('turns a duration-based series into an explicit end for the override',async()=> {
  const data=ics(vevent('UID:d','DTSTART:20300101T100000Z','DURATION:PT2H','SUMMARY:D','RRULE:FREQ=WEEKLY'));
  const {r,writes}=await run(data,{title:'Named'});
  assert.equal(r.isError,false);
  const o=events(writes[0].data!)[1];
  assert.equal(o.hasProperty('duration'),false);
  assert.equal(text(o,'dtend'),'2030-01-08T12:00:00Z');
  const moved=events((await run(data,{start:'2030-01-08T11:00:00Z'})).writes[0].data!)[1];
  assert.equal(text(moved,'dtstart'),'2030-01-08T11:00:00Z');
  assert.equal(text(moved,'dtend'),'2030-01-08T13:00:00Z');
 });

 test('edits one occurrence of an all-day series, with dates',async()=> {
  const data=ics(vevent('UID:a','DTSTART;VALUE=DATE:20300101','DTEND;VALUE=DATE:20300102','SUMMARY:A','RRULE:FREQ=DAILY'));
  const {r,writes}=await run(data,{title:'Special day',start:'2030-01-03',end:'2030-01-04',occurrence:'2030-01-03T00:00:00Z'});
  assert.equal(r.isError,false);
  const o=events(writes[0].data!)[1];
  assert.equal(text(o,'summary'),'Special day');
  assert.match(writes[0].data!,/RECURRENCE-ID;VALUE=DATE:20300103/);
  assert.match(writes[0].data!,/DTEND;VALUE=DATE:20300105/);
 });

 test('an occurrence cannot be given its own repeat rule',async()=> {
  const {r,writes}=await run(ics(WEEKLY),{rrule:'FREQ=DAILY'});
  assert.equal(r.isError,true);
  assert.deepEqual(writes,[]);
 });

 test.each([
  ['a time the series does not generate',ics(WEEKLY),{occurrence:'2030-01-09T10:00:00Z'}],
  ['a cancelled occurrence',ics(timed('w','20300101T100000Z','20300101T110000Z','RRULE:FREQ=WEEKLY','EXDATE:20300108T100000Z')),{}],
  ['an end before the start',ics(WEEKLY),{end:'2030-01-08T09:00:00Z'}],
  ['a start past the end',ics(WEEKLY),{start:'2030-01-08T12:00:00Z',end:'2030-01-08T11:00:00Z'}],
  ['an edit that changes nothing',ics(WEEKLY),{title:undefined}],
  ['a one-off event',ics(timed('p','20300101T100000Z','20300101T110000Z')),{}],
  ['an invitation',ics(timed('i','20300101T100000Z','20300101T110000Z','RRULE:FREQ=WEEKLY','ATTENDEE:mailto:a@example.test')),{}],
 ] as const)('refuses %s',async(_name,data,args)=> {
  const {r,writes}=await run(data,{title:'Changed',...args});
  assert.equal(r.isError,true);
  assert.deepEqual(writes,[]);
 });

 test('refuses when the event changed since it was read',async()=> {
  const {r,writes}=await run(ics(WEEKLY),{title:'Changed'},'"2"');
  assert.equal(r.isError,true);
  assert.deepEqual(writes,[]);
 });

 test('reports a refused save as a failure',async()=> {
  const t=await tools([obj('s.ics',ics(WEEKLY))],ENV,OWNER,{writeStatus:412});
  const r=await t.call('update_event',edit(CAL+'s.ics',{occurrence:'2030-01-08T10:00:00Z'}));
  assert.equal(r.isError,true);
  assert.equal(r.body.updated,undefined);
 });

 test('still refuses to edit a whole series without an occurrence',async()=> {
  const {call,writes}=await tools([obj('s.ics',ics(WEEKLY))]);
  assert.equal((await call('update_event',edit(CAL+'s.ics'))).isError,true);
  assert.deepEqual(writes,[]);
 });
});

describe('this and following occurrences of a series',()=> {
 const ZONE=(...series:string[])=>ics('BEGIN:VTIMEZONE','TZID:America/Los_Angeles','BEGIN:DAYLIGHT','TZOFFSETFROM:-0800','TZOFFSETTO:-0700','TZNAME:PDT','DTSTART:19700308T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','END:DAYLIGHT','BEGIN:STANDARD','TZOFFSETFROM:-0700','TZOFFSETTO:-0800','TZNAME:PST','DTSTART:19701101T020000','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','END:STANDARD','END:VTIMEZONE',...series);
 const LA=(...extra:string[])=>ZONE(vevent('UID:z','DTSTART;TZID=America/Los_Angeles:20301026T090000','DTEND;TZID=America/Los_Angeles:20301026T100000','SUMMARY:Swap','RRULE:FREQ=WEEKLY',...extra));
 const week=(...extra:string[])=>ics(vevent('UID:w','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:Weekly','LOCATION:Hall','RRULE:FREQ=WEEKLY',...extra));
 const AT='2030-01-15T10:00:00Z';
 const events=(data:string)=>parse(data).getAllSubcomponents('vevent');
 const split=async(data:string,args:Record<string,unknown>={},occurrence=AT)=> {
  const t=await tools([obj('s.ics',data)]);
  return {...t,r:await t.call('update_event',edit(CAL+'s.ics',{title:'Changed',occurrence,scope:'thisAndFollowing',...args}))};
 };
 const ended=async(data:string,occurrence=AT)=> {
  const t=await tools([obj('s.ics',data)]);
  return {...t,r:await t.call('delete_event',del(CAL+'s.ics',{occurrence,scope:'thisAndFollowing'}))};
 };

 describe('editing',()=> {
  test('ends the old series before the occurrence and starts a new one there',async()=> {
   const {r,writes}=await split(week());
   assert.equal(r.isError,false);
   assert.equal(writes.length,2);
   const [made,cut]=writes;
   assert.equal(made.op,'create');
   assert.deepEqual(made.headers,{'If-None-Match':'*'});
   assert.match(made.url,/^https:\/\/calendar\.example\.test\/1\/calendars\/home\/[0-9a-f-]+\.ics$/);
   assert.deepEqual(r.body,{updated:true,resourceId:CAL+'s.ics',newResourceId:made.url,occurrence:AT,scope:'thisAndFollowing'});
   const fresh=only(made.data!);
   assert.match(text(fresh,'uid'),/^[0-9a-f-]+@private-caldav-mcp$/);
   assert.notEqual(text(fresh,'uid'),'w');
   assert.equal(text(fresh,'summary'),'Changed');
   assert.equal(text(fresh,'dtstart'),'2030-01-15T10:00:00Z');
   assert.equal(text(fresh,'dtend'),'2030-01-15T11:00:00Z');
   assert.equal(text(fresh,'rrule'),'FREQ=WEEKLY');
   assert.equal(text(fresh,'location'),'Hall');
   assert.equal(cut.op,'update');
   assert.equal(cut.url,CAL+'s.ics');
   assert.equal(cut.etag,'"1"');
   const old=only(cut.data!);
   assert.equal(text(old,'uid'),'w');
   assert.equal(text(old,'summary'),'Weekly');
   assert.equal(text(old,'dtstart'),'2030-01-01T10:00:00Z');
   assert.equal(text(old,'rrule'),'FREQ=WEEKLY;UNTIL=20300115T095959Z');
  });

  test('the two series together list every occurrence once, with the change only from the split on',async()=> {
   const {writes}=await split(week());
   const t=await tools([obj('old.ics',writes[1].data!),obj('new.ics',writes[0].data!)]);
   const r=await t.call('list_events',{...RANGE,end:'2030-01-30T00:00:00Z'});
   assert.deepEqual(r.body.occurrences.map((o:any)=>[o.start,o.title]),[
    ['2030-01-01T10:00:00.000Z','Weekly'],['2030-01-08T10:00:00.000Z','Weekly'],
    ['2030-01-15T10:00:00.000Z','Changed'],['2030-01-22T10:00:00.000Z','Changed'],['2030-01-29T10:00:00.000Z','Changed']]);
  });

  test('divides a counted series between the two',async()=> {
   const {writes}=await split(week('X-N:1').replace('RRULE:FREQ=WEEKLY','RRULE:FREQ=WEEKLY;COUNT=5'),{},'2030-01-15T10:00:00Z');
   assert.equal(text(only(writes[0].data!),'rrule'),'FREQ=WEEKLY;COUNT=3');
   assert.equal(text(only(writes[1].data!),'rrule'),'FREQ=WEEKLY;UNTIL=20300115T095959Z');
  });

  test('gives each series the cancelled dates that fall in its part',async()=> {
   const {writes}=await split(week('EXDATE:20300108T100000Z,20300122T100000Z'));
   assert.deepEqual(only(writes[1].data!).getAllProperties('exdate').flatMap(p=>p.getValues().map(String)),['2030-01-08T10:00:00Z']);
   assert.deepEqual(only(writes[0].data!).getAllProperties('exdate').flatMap(p=>p.getValues().map(String)),['2030-01-22T10:00:00Z']);
  });

  test('moves later edited occurrences to the new series and keeps earlier ones',async()=> {
   const before=vevent('UID:w','RECURRENCE-ID:20300108T100000Z','DTSTART:20300108T120000Z','DTEND:20300108T130000Z','SUMMARY:Early');
   const after=vevent('UID:w','RECURRENCE-ID:20300122T100000Z','DTSTART:20300122T120000Z','DTEND:20300122T130000Z','SUMMARY:Late');
   const data=ics(vevent('UID:w','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:Weekly','RRULE:FREQ=WEEKLY'),before,after);
   const {writes}=await split(data);
   const old=events(writes[1].data!), fresh=events(writes[0].data!);
   assert.deepEqual(old.map(e=>text(e,'summary')),['Weekly','Early']);
   assert.deepEqual(fresh.map(e=>text(e,'summary')),['Changed','Late']);
   assert.equal(text(fresh[1],'uid'),text(fresh[0],'uid'));
   assert.notEqual(text(fresh[1],'uid'),'w');
   assert.equal(text(fresh[1],'recurrence-id'),'2030-01-22T10:00:00Z');
  });

  test('keeps alarms and the saved timezone in both series',async()=> {
   const data=ZONE(vevent('UID:z','DTSTART;TZID=America/Los_Angeles:20301026T090000','DTEND;TZID=America/Los_Angeles:20301026T100000','SUMMARY:Swap','RRULE:FREQ=WEEKLY','BEGIN:VALARM','ACTION:DISPLAY','TRIGGER:-PT10M','DESCRIPTION:A','END:VALARM'));
   const {writes}=await split(data,{},'2030-11-09T17:00:00Z');
   for (const w of writes) assert.equal(w.data!.includes('BEGIN:VTIMEZONE'),true);
   assert.equal(only(writes[0].data!).getAllSubcomponents('valarm').length,1);
   const fresh=only(writes[0].data!);
   assert.equal(fresh.getFirstProperty('dtstart')!.getParameter('tzid'),'America/Los_Angeles');
   assert.equal(String(fresh.getFirstPropertyValue('dtstart')),'2030-11-09T09:00:00');
   assert.equal(text(only(writes[1].data!),'rrule'),'FREQ=WEEKLY;UNTIL=20301109T165959Z');
  });

  test('changes the time of day from the split on, in the series zone, across the November change',async()=> {
   // 2030-11-09 09:00 PST = 17:00Z; start one hour later and end 90 minutes later
   const {r,writes}=await split(LA(),{start:'2030-11-09T18:00:00Z',end:'2030-11-09T19:30:00Z'},'2030-11-09T17:00:00Z');
   assert.equal(r.isError,false);
   const fresh=only(writes[0].data!);
   assert.equal(String(fresh.getFirstPropertyValue('dtstart')),'2030-11-09T10:00:00');
   assert.equal(String(fresh.getFirstPropertyValue('dtend')),'2030-11-09T11:30:00');
   assert.equal(fresh.getFirstProperty('dtstart')!.getParameter('tzid'),'America/Los_Angeles');
   const t=await tools([obj('old.ics',writes[1].data!),obj('new.ics',writes[0].data!)]);
   const l=await t.call('list_events',{calendarId:CAL,start:'2030-10-25T00:00:00Z',end:'2030-11-24T00:00:00Z'});
   assert.deepEqual(l.body.occurrences.map((o:any)=>o.start),['2030-10-26T16:00:00.000Z','2030-11-02T16:00:00.000Z','2030-11-09T18:00:00.000Z','2030-11-16T18:00:00.000Z','2030-11-23T18:00:00.000Z']);
  });

  test('moving only the start keeps the length, and only the end keeps the start',async()=> {
   const a=await split(week(),{start:'2030-01-15T12:00:00Z'});
   assert.equal(text(only(a.writes[0].data!),'dtstart'),'2030-01-15T12:00:00Z');
   assert.equal(text(only(a.writes[0].data!),'dtend'),'2030-01-15T13:00:00Z');
   const b=await split(week(),{end:'2030-01-15T10:30:00Z'});
   assert.equal(text(only(b.writes[0].data!),'dtstart'),'2030-01-15T10:00:00Z');
   assert.equal(text(only(b.writes[0].data!),'dtend'),'2030-01-15T10:30:00Z');
  });

  test('changes location and description alone',async()=> {
   const {writes}=await split(week(),{title:undefined,location:'Room 2',description:'New'});
   const fresh=only(writes[0].data!);
   assert.equal(text(fresh,'summary'),'Weekly');
   assert.equal(text(fresh,'location'),'Room 2');
   assert.equal(text(fresh,'description'),'New');
  });

  test('works for a series with floating times',async()=> {
   const data=ics(vevent('UID:f','DTSTART:20300101T100000','DTEND:20300101T110000','SUMMARY:Float','RRULE:FREQ=WEEKLY'));
   const {r,writes}=await split(data,{},'2030-01-15T10:00:00Z');
   assert.equal(r.isError,false);
   assert.equal(text(only(writes[1].data!),'rrule'),'FREQ=WEEKLY;UNTIL=20300115T095959');
  });

  test.each([
   ['a time the series does not generate',week(),{},'2030-01-16T10:00:00Z'],
   ['a cancelled occurrence',week('EXDATE:20300115T100000Z'),{},AT],
   ['an edit that changes nothing',week(),{title:undefined},AT],
   ['a one-off event',ics(timed('p','20300101T100000Z','20300101T110000Z')),{},AT],
   ['an invitation',week('ORGANIZER:mailto:a@example.test'),{},AT],
   ['a move to another day for a series on fixed days',ics(vevent('UID:w','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:W','RRULE:FREQ=WEEKLY;BYDAY=TU')),{start:'2030-01-16T10:00:00Z'},AT],
   ['an end before the start',week(),{end:'2030-01-15T09:00:00Z'},AT],
  ] as const)('refuses %s and writes nothing',async(_name,data,args,at)=> {
   const {r,writes}=await split(data,args,at);
   assert.equal(r.isError,true);
   assert.deepEqual(writes,[]);
  });

  test('at the first occurrence edits the whole series in place and creates nothing',async()=> {
   const {r,writes}=await split(week(),{},'2030-01-01T10:00:00Z');
   assert.equal(r.isError,false);
   assert.equal(writes.length,1);
   assert.equal(writes[0].op,'update');
   assert.equal(text(only(writes[0].data!),'summary'),'Changed');
   assert.equal(text(only(writes[0].data!),'uid'),'w');
   assert.equal(r.body.newResourceId,undefined);
  });

  test('moves extra dates after the split to the new series',async()=> {
   const {writes}=await split(week('RDATE:20300103T100000Z,20300124T100000Z'));
   assert.deepEqual(only(writes[1].data!).getAllProperties('rdate').flatMap(p=>p.getValues().map(String)),['2030-01-03T10:00:00Z']);
   assert.deepEqual(only(writes[0].data!).getAllProperties('rdate').flatMap(p=>p.getValues().map(String)),['2030-01-24T10:00:00Z']);
  });

  test('splits a series made only of extra dates',async()=> {
   const data=ics(vevent('UID:r','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:R','RDATE:20300108T100000Z,20300115T100000Z'));
   const {r,writes}=await split(data);
   assert.equal(r.isError,false);
   assert.equal(writes.length,2);
   assert.equal(only(writes[0].data!).hasProperty('rrule'),false);
   assert.equal(only(writes[1].data!).hasProperty('rrule'),false);
  });

  test('keeps an exclusion rule on both series',async()=> {
   const {writes}=await split(week('EXRULE:FREQ=WEEKLY;COUNT=1'));
   assert.equal(only(writes[0].data!).hasProperty('exrule'),true);
   assert.equal(only(writes[1].data!).hasProperty('exrule'),true);
  });

  test('splits an all-day series',async()=> {
   const data=ics(vevent('UID:a','DTSTART;VALUE=DATE:20300101','DTEND;VALUE=DATE:20300102','SUMMARY:A','RRULE:FREQ=DAILY'));
   const {r,writes}=await split(data,{start:'2030-01-05',end:'2030-01-06'},'2030-01-05T00:00:00Z');
   assert.equal(r.isError,false);
   assert.match(writes[0].data!,/DTSTART;VALUE=DATE:20300105/);
   assert.match(writes[0].data!,/DTEND;VALUE=DATE:20300107/);
   assert.equal(text(only(writes[1].data!),'rrule'),'FREQ=DAILY;UNTIL=20300104');
  });

  test('moves the cancelled dates and edited occurrences along with a later time',async()=> {
   const late=vevent('UID:w','RECURRENCE-ID:20300122T100000Z','DTSTART:20300122T150000Z','DTEND:20300122T160000Z','SUMMARY:Late');
   const data=ics(vevent('UID:w','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:W','RRULE:FREQ=WEEKLY','EXDATE:20300129T100000Z'),late);
   const {r,writes}=await split(data,{start:'2030-01-15T12:00:00Z'});
   assert.equal(r.isError,false);
   const fresh=events(writes[0].data!);
   assert.equal(text(fresh[0],'dtstart'),'2030-01-15T12:00:00Z');
   assert.equal(text(fresh[0],'exdate'),'2030-01-29T12:00:00Z');
   assert.equal(text(fresh[1],'recurrence-id'),'2030-01-22T12:00:00Z');
   assert.equal(text(fresh[1],'dtstart'),'2030-01-22T15:00:00Z');
   const t=await tools([obj('old.ics',writes[1].data!),obj('new.ics',writes[0].data!)]);
   const l=await t.call('list_events',{...RANGE,end:'2030-02-05T00:00:00Z'});
   assert.deepEqual(l.body.occurrences.map((o:any)=>[o.start,o.title]),[['2030-01-01T10:00:00.000Z','W'],['2030-01-08T10:00:00.000Z','W'],['2030-01-15T12:00:00.000Z','Changed'],['2030-01-22T15:00:00.000Z','Late']]);
  });

  test('moves a series without fixed days to another day, and a fixed-day one with a new rule',async()=> {
   const a=await split(week(),{start:'2030-01-16T10:00:00Z'});
   assert.equal(a.r.isError,false);
   assert.equal(text(only(a.writes[0].data!),'dtstart'),'2030-01-16T10:00:00Z');
   const tuesdays=ics(vevent('UID:w','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:W','RRULE:FREQ=WEEKLY;BYDAY=TU'));
   const b=await split(tuesdays,{start:'2030-01-16T10:00:00Z',rrule:'FREQ=WEEKLY;BYDAY=WE'});
   assert.equal(b.r.isError,false);
   assert.equal(text(only(b.writes[0].data!),'rrule'),'FREQ=WEEKLY;BYDAY=WE');
  });

  test('keeps the duration of a duration-based series',async()=> {
   const data=ics(vevent('UID:d','DTSTART:20300101T100000Z','DURATION:PT2H','SUMMARY:D','RRULE:FREQ=WEEKLY'));
   const {writes}=await split(data,{start:'2030-01-15T11:00:00Z'});
   const fresh=only(writes[0].data!);
   assert.equal(text(fresh,'dtstart'),'2030-01-15T11:00:00Z');
   assert.equal(text(fresh,'duration'),'PT2H');
   const ended=await split(data,{end:'2030-01-15T13:00:00Z'});
   assert.equal(only(ended.writes[0].data!).hasProperty('duration'),false);
   assert.equal(text(only(ended.writes[0].data!),'dtend'),'2030-01-15T13:00:00Z');
  });

  test('gives the new series its own repeat rule',async()=> {
   const {writes}=await split(week(),{rrule:'FREQ=DAILY;COUNT=3'});
   assert.equal(text(only(writes[0].data!),'rrule'),'FREQ=DAILY;COUNT=3');
   assert.equal(text(only(writes[1].data!),'rrule'),'FREQ=WEEKLY;UNTIL=20300115T095959Z');
  });

  test('refuses when the event changed since it was read',async()=> {
   const t=await tools([obj('s.ics',week(),'"2"')]);
   const r=await t.call('update_event',edit(CAL+'s.ics',{occurrence:AT,scope:'thisAndFollowing'}));
   assert.equal(r.isError,true);
   assert.deepEqual(t.writes,[]);
  });

  test('needs an occurrence',async()=> {
   const t=await tools([obj('s.ics',week())]);
   assert.equal((await t.call('update_event',edit(CAL+'s.ics',{scope:'thisAndFollowing'}))).isError,true);
   assert.deepEqual(t.writes,[]);
  });

  describe('when a write fails',()=> {
   const failing=async(failCreate:boolean)=> {
    const log:string[]=[];
    const client={
     fetchCalendars:async()=>[{url:CAL,displayName:'Home'}],
     fetchCalendarObjects:async()=>[obj('s.ics',week())],
     createCalendarObject:async({filename}:any)=>{log.push('create '+filename);return new Response(null,{status:failCreate?403:201});},
     updateCalendarObject:async()=>{log.push('update');return new Response(null,{status:412});},
     deleteCalendarObject:async({calendarObject}:any)=>{log.push('delete '+calendarObject.url);return new Response(null,{status:204});},
    };
    const t=await tools([],ENV,OWNER,{client});
    return {log,r:await t.call('update_event',edit(CAL+'s.ics',{occurrence:AT,scope:'thisAndFollowing'}))};
   };

   test('removes the new series again when the old one cannot be shortened',async()=> {
    const {log,r}=await failing(false);
    assert.equal(r.isError,true);
    assert.deepEqual(log.map(l=>l.split(' ')[0]),['create','update','delete']);
    assert.equal(log[2].split(' ')[1],CAL+log[0].split(' ')[1]);
   });

   test('does not touch the old series when the new one cannot be created',async()=> {
    const {log,r}=await failing(true);
    assert.equal(r.isError,true);
    assert.deepEqual(log.map(l=>l.split(' ')[0]),['create']);
   });

   test('still reports the failure when removing the new series fails too',async()=> {
    const client={
     fetchCalendars:async()=>[{url:CAL,displayName:'Home'}],
     fetchCalendarObjects:async()=>[obj('s.ics',week())],
     createCalendarObject:async()=>new Response(null,{status:201}),
     updateCalendarObject:async()=>new Response(null,{status:412}),
     deleteCalendarObject:async()=>{throw new Error('offline');},
    };
    const t=await tools([],ENV,OWNER,{client});
    const r=await t.call('update_event',edit(CAL+'s.ics',{occurrence:AT,scope:'thisAndFollowing'}));
    assert.equal(r.isError,true);
    assert.match(r.body.error,/^Conflict/);
   });
  });
 });

 describe('cancelling',()=> {
  test('ends the series before the occurrence and keeps everything earlier',async()=> {
   const {r,writes}=await ended(week());
   assert.deepEqual(r.body,{cancelled:true,resourceId:CAL+'s.ics',occurrence:AT,scope:'thisAndFollowing'});
   assert.equal(writes.length,1);
   assert.equal(writes[0].op,'update');
   assert.equal(writes[0].etag,'"1"');
   assert.equal(text(only(writes[0].data!),'rrule'),'FREQ=WEEKLY;UNTIL=20300115T095959Z');
   const t=await tools([obj('s.ics',writes[0].data!)]);
   const l=await t.call('list_events',{...RANGE,end:'2030-02-15T00:00:00Z'});
   assert.deepEqual(l.body.occurrences.map((o:any)=>o.start),['2030-01-01T10:00:00.000Z','2030-01-08T10:00:00.000Z']);
  });

  test('drops later cancelled dates and edited occurrences, keeping earlier ones',async()=> {
   const early=vevent('UID:w','RECURRENCE-ID:20300108T100000Z','DTSTART:20300108T120000Z','DTEND:20300108T130000Z','SUMMARY:Early');
   const late=vevent('UID:w','RECURRENCE-ID:20300122T100000Z','DTSTART:20300122T120000Z','DTEND:20300122T130000Z','SUMMARY:Late');
   const data=ics(vevent('UID:w','DTSTART:20300101T100000Z','DTEND:20300101T110000Z','SUMMARY:W','RRULE:FREQ=WEEKLY','EXDATE:20300108T100000Z,20300129T100000Z'),early,late);
   const {writes}=await ended(data);
   const all=events(writes[0].data!);
   assert.deepEqual(all.map(e=>text(e,'summary')),['W','Early']);
   assert.deepEqual(all[0].getAllProperties('exdate').flatMap(p=>p.getValues().map(String)),['2030-01-08T10:00:00Z']);
  });

  test('deletes the whole event when that is the first occurrence',async()=> {
   const {r,writes}=await ended(week(),'2030-01-01T10:00:00Z');
   assert.deepEqual(r.body,{deleted:true,resourceId:CAL+'s.ics',occurrence:'2030-01-01T10:00:00Z',scope:'thisAndFollowing'});
   assert.deepEqual(writes,[{op:'delete',url:CAL+'s.ics',etag:'"1"'}]);
  });

  test('ends an all-day series on the day before',async()=> {
   const data=ics(vevent('UID:a','DTSTART;VALUE=DATE:20300101','DTEND;VALUE=DATE:20300102','SUMMARY:A','RRULE:FREQ=DAILY'));
   const {r,writes}=await ended(data,'2030-01-05T00:00:00Z');
   assert.equal(r.isError,false);
   assert.equal(text(only(writes[0].data!),'rrule'),'FREQ=DAILY;UNTIL=20300104');
  });

  test.each([
   ['a time the series does not generate',week(),'2030-01-16T10:00:00Z'],
   ['an invitation without the confirmation',week('ATTENDEE:mailto:a@example.test'),AT],
   ['a one-off event',ics(timed('p','20300101T100000Z','20300101T110000Z')),AT],
  ] as const)('refuses %s and writes nothing',async(_name,data,at)=> {
   const {r,writes}=await ended(data,at);
   assert.equal(r.isError,true);
   assert.deepEqual(writes,[]);
  });

  test('needs an occurrence, and a whole-series request cannot be combined with one',async()=> {
   const t=await tools([obj('s.ics',week())]);
   assert.equal((await t.call('delete_event',del(CAL+'s.ics',{scope:'thisAndFollowing',confirmEntireSeries:true}))).isError,true);
   assert.equal((await t.call('delete_event',del(CAL+'s.ics',{scope:'thisAndFollowing'}))).isError,true);
   assert.equal((await t.call('delete_event',del(CAL+'s.ics',{occurrence:AT,scope:'thisAndFollowing',confirmEntireSeries:true}))).isError,true);
   assert.deepEqual(t.writes,[]);
  });
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

  test('cancels an occurrence that has its own edited copy, dropping the copy',async()=> {
   const data=ics(WEEKLY,vevent('UID:w','RECURRENCE-ID:20300108T100000Z','DTSTART:20300108T120000Z','DTEND:20300108T130000Z','SUMMARY:Moved'));
   const {r,writes}=await run(data,'2030-01-08T10:00:00Z');
   assert.equal(r.isError,false);
   const all=parse(writes[0].data!).getAllSubcomponents('vevent');
   assert.equal(all.length,1);
   assert.equal(text(all[0],'exdate'),'2030-01-08T10:00:00Z');
   // other occurrences of the same resource keep their copies
   const other=await run(data,'2030-01-15T10:00:00Z');
   assert.equal(parse(other.writes[0].data!).getAllSubcomponents('vevent').length,2);
  });

  test('refuses things that are not a plain series',async()=> {
   const cases:[string,string][]=[
    ['a one-off event',ics(timed('p','20300101T100000Z','20300101T110000Z'))],
    ['a resource with only edited copies',ics(vevent('UID:o','RECURRENCE-ID:20300108T100000Z','DTSTART:20300108T100000Z','DTEND:20300108T110000Z','SUMMARY:x'))],
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
