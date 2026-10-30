'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {periodStarts,activitySummary,registerWorkforce}=require('./workforce');const {smsConfig}=require('./service-sms');
test('earnings day, Monday week and month boundaries use IST',()=>{
 const r=periodStarts(new Date('2026-11-01T01:00:00Z'));
 assert.equal(r.today.toISOString(),'2026-10-31T18:30:00.000Z');
 assert.equal(r.week.toISOString(),'2026-10-25T18:30:00.000Z');
 assert.equal(r.month.toISOString(),'2026-10-31T18:30:00.000Z');
});
test('online availability uses interval union, excludes future and respects expiry',()=>{
 const now=new Date('2026-10-30T06:00:00Z');
 const result=activitySummary([
 {startedAt:'2026-10-30T03:00:00Z',expiresAt:'2026-10-30T08:00:00Z'},
 {startedAt:'2026-10-30T04:00:00Z',expiresAt:'2026-10-30T05:00:00Z'},
 {startedAt:'2026-10-30T07:00:00Z',expiresAt:'2026-10-30T08:00:00Z'},
 {startedAt:'2026-10-30T01:00:00Z',expiresAt:'2026-10-30T02:00:00Z',endedAt:'2026-10-30T03:00:00Z'},
 ],now);
 assert.equal(result.onlineMinutes,240);assert.equal(result.onlineDays,1);
});
test('an availability shift crossing IST midnight counts both days only once',()=>{
 const r=activitySummary([{startedAt:'2026-10-29T18:00:00Z',expiresAt:'2026-10-29T19:00:00Z'}],new Date('2026-10-30T00:00:00Z'));
 assert.equal(r.onlineMinutes,60);assert.equal(r.onlineDays,2);
});
test('SMS stays inactive without explicit enablement and every approved template',()=>{
 const env={HOMEFIX_SMS_ENABLED:'true',MSG91_AUTH_KEY:'test-only'};
 assert.equal(smsConfig(env).ready,false);for(const row of smsConfig(env).events)env['MSG91_TEMPLATE_'+row.event.toUpperCase()]='approved-test-template';
 assert.equal(smsConfig(env).ready,true);env.HOMEFIX_SMS_ENABLED='false';assert.equal(smsConfig(env).ready,false);
 assert.equal(JSON.stringify(smsConfig(env)).includes('test-only'),false);
});
function fixture(){const routes=new Map();let queried=null;const app={locals:{},get:(p,...h)=>routes.set('get '+p,h),patch:(p,...h)=>routes.set('patch '+p,h),post:(p,...h)=>routes.set('post '+p,h)};
 const worker={_id:'111111111111111111111111',name:'Worker',phone:'9999999999',hasProfilePhoto:true,profilePhotoData:null};
 const chain=v=>({select(){return this;},lean:async()=>v,sort(){return this;},then(r,j){return Promise.resolve(v).then(r,j);}});
 const Worker={findById:()=>chain(worker),findOneAndUpdate:async(f,u)=>{queried=f;return worker;}};
 const Booking={findOne:f=>{queried=f;return Promise.resolve(null);},countDocuments:async()=>2,find:()=>chain([]),findOneAndUpdate:async f=>{queried=f;return null;}};
 const mongoose={models:{WorkerShift:{find:()=>chain([])},ServiceReview:{aggregate:async()=>[{average:4.5,count:2}]},WorkerSettlement:{find:()=>chain([])}},isValidObjectId:v=>/^[a-f0-9]{24}$/.test(v),Schema:class{}};
 const guard=(req,res,next)=>next(),wrap=fn=>fn;
 registerWorkforce({app,mongoose,Worker,Booking,requireWorker:guard,requireCustomer:guard,requireAdminKey:guard,wrap,publicWorker:v=>({...v})});
 async function run(method,path,body={}){return new Promise((resolve,reject)=>{const handlers=routes.get(method+' '+path);const req={params:{id:'abcdefabcdefabcdefabcdef'},body,worker,customer:{uid:'owner-a'}};const res={code:200,status(n){this.code=n;return this;},json(data){resolve({code:this.code,data});}};let i=0;function next(){Promise.resolve(handlers[i++](req,res,next)).catch(reject);}next();});}
 return{run,get query(){return queried;}};
}
test('customer worker profile requires ownership of assigned booking',async()=>{const f=fixture();const r=await f.run('get','/api/customer/bookings/:id/worker');assert.equal(r.code,404);assert.equal(f.query.customerUid,'owner-a');});
test('worker price approval compares assignment, exact price and exact commission',async()=>{const f=fixture();assert.equal((await f.run('post','/api/worker/bookings/:id/price-accept',{amountPaise:50000})).code,400);
 const r=await f.run('post','/api/worker/bookings/:id/price-accept',{amountPaise:50000,commissionMode:'percent',commissionValue:20});assert.equal(r.code,409);assert.equal(f.query.assignedWorkerId,'111111111111111111111111');assert.deepEqual(f.query.commissionValue,{$in:[20,null]});assert.equal(f.query.workStartedAt,null);});
test('worker profile validates photo size and accepts only real image headers',async()=>{const f=fixture();const r=await f.run('patch','/api/worker/profile',{name:'Worker',photoData:'data:image/svg+xml;base64,PHN2Zz4='});assert.equal(r.code,400);assert.equal(f.query,null);});
