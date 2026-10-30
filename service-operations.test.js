'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {registerServiceOperations,eligible,validPin,safeOffer,completionHash}=require('./service-operations');
const {encryptPrivate}=require('./business-tools');
process.env.ADMIN_SESSION_SECRET='test-only-service-operations-secret-32-characters';
const bid='abcdefabcdefabcdefabcdef',w1='111111111111111111111111',w2='222222222222222222222222';
const clone=v=>v==null?v:structuredClone(v);
function at(obj,path){return path.split('.').reduce((v,k)=>v?.[k],obj);}
function matches(doc,filter){
 if(!doc)return false;
 return Object.entries(filter).every(([k,q])=>{
  if(k==='$or')return q.some(v=>matches(doc,v));if(k==='$and')return q.every(v=>matches(doc,v));
  const value=at(doc,k);
  if(q===null)return value==null;
  if(q&&typeof q==='object'&&!(q instanceof Date))return Object.entries(q).every(([op,v])=>{
   const list=Array.isArray(value)?value:[value];
   if(op==='$in')return list.some(x=>v.includes(x));if(op==='$nin')return list.every(x=>!v.includes(x));
   if(op==='$ne')return v===null?value!=null:value!==v;if(op==='$exists')return (value!==undefined)===v;
   if(op==='$gt')return value>v;if(op==='$gte')return value>=v;if(op==='$lt')return value<v;
   return false;
  });
  return Array.isArray(value)?value.includes(q):q instanceof Date?+value===+q:value===q;
 });
}
function setPath(obj,path,value){const parts=path.split('.'),last=parts.pop();let target=obj;for(const part of parts)target=target[part]??={};target[last]=value;}
function update(doc,change){for(const [path,value] of Object.entries(change.$set||{}))setPath(doc,path,clone(value));for(const [path,value] of Object.entries(change.$inc||{}))setPath(doc,path,(at(doc,path)||0)+value);for(const path of Object.keys(change.$unset||{}))delete doc[path];}
function query(value){let fields;const q={select(f){fields=f;return this;},sort(){return this;},skip(){return this;},limit(){return this;},session(){return this;},lean:async()=>project(value),then(resolve,reject){return Promise.resolve(project(value)).then(resolve,reject);}};
 function project(v){if(!fields||fields.startsWith('+'))return clone(v);const pick=x=>{if(!x)return x;const result={};for(const field of fields.split(' ').filter(p=>!p.startsWith('-')))if(x[field]!==undefined)result[field]=x[field];if(!fields.includes('-_id')&&x._id!==undefined)result._id=x._id;return result;};return Array.isArray(v)?v.map(pick):pick(v);}
 return q;
}
function fixture(overrides={}){
 const worker={_id:w1,name:'Worker A',active:true,hasProfilePhoto:true,phone:'9999999999',phoneVerified:true,verificationStatus:'approved',payoutSummary:'UPI masked',online:true,availableUntil:new Date(Date.now()+3600000),approvedSkills:['Plumbing'],...overrides.worker};
 const state={booking:{_id:bid,customerUid:'customer-a',customerName:'Private Customer',phone:'9999999999',address:'Private address',service:'Plumbing',date:'2026-11-01',time:'10 AM',status:'accepted',assignedWorkerId:w1,
  quotedAmountPaise:50000,paymentMethod:'cash_on_service',paymentStatus:'pending_collection',workStartedAt:new Date(),quoteAcceptedAt:new Date(),
  completionRequestedAt:new Date(),completionPhotoWorkerId:w1,completionOtpAttempts:0,completionOtpIssueCount:0,review:null,
  problemPhotosEncrypted:encryptPrivate(['problem-image'],`booking:${bid}:problem`),completionPhotosEncrypted:encryptPrivate(['result-image'],`booking:${bid}:result`),...overrides.booking},notifications:[],reviews:[],tickets:[]};
 const workers=[worker,{...worker,_id:w2,name:'Worker B'}],calls=[];
 const Booking={findById:async()=>clone(state.booking),findOne:filter=>query(matches(state.booking,filter)?state.booking:null),find:filter=>query(matches(state.booking,filter)?[state.booking]:[]),
  async findOneAndUpdate(filter,change){calls.push(['bookingUpdate',filter,change]);if(!matches(state.booking,filter))return null;update(state.booking,change);return clone(state.booking);},
  async updateOne(filter,change){if(!matches(state.booking,filter))return{modifiedCount:0};update(state.booking,change);return{modifiedCount:1};},exists:async filter=>matches(state.booking,filter)};
 const Worker={find:filter=>query(workers.filter(w=>matches(w,filter))),findOne:filter=>query(workers.find(w=>matches(w,filter))),
  async findByIdAndUpdate(id,change){const w=workers.find(x=>x._id===id);if(!w)return null;update(w,change);return clone(w);}};
 const Notification={schema:{index(){}},async insertMany(records){state.notifications.push(...clone(records));},find:filter=>query(state.notifications.filter(v=>matches(v,filter))),countDocuments:async filter=>state.notifications.filter(v=>matches(v,filter)).length,async updateMany(){}};
 const Device={find:()=>query([])};
 const Ticket={findOne:filter=>query(state.tickets.find(t=>matches(t,filter))),find:filter=>query(state.tickets.filter(t=>matches(t,filter))),countDocuments:async()=>0,
  async create(body){const item={_id:bid,...clone(body)};state.tickets.push(item);return item;},async findOneAndUpdate(){return null;}};
 const Review={async init(){},find:filter=>query(state.reviews.filter(r=>matches(r,filter))),aggregate:async()=>[],async create(records){state.reviews.push(...clone(records));return records.map(r=>({...r,createdAt:new Date()}));}};
 const app={locals:{}};const routes=new Map();for(const method of ['get','post','patch','delete'])app[method]=(path,...handlers)=>routes.set(`${method} ${path}`,handlers);
 const guard=role=>(req,res,next)=>req.role===role?next():res.status(401).json({message:'Unauthorized'});
 const wrap=fn=>async(req,res,next)=>{try{await fn(req,res,next);}catch(error){res.status(500).json({message:'Test request failed',type:error.name});}};
 const mongoose={Schema:class{static Types={Mixed:Object,ObjectId:String};},models:{AppNotification:Notification,AppDevice:Device,SupportTicket:Ticket,ServiceReview:Review},
  isValidObjectId:value=>/^[a-f0-9]{24}$/i.test(value||''),async startSession(){return{async withTransaction(fn){const before=clone(state);try{return await fn();}catch(error){Object.assign(state,before);throw error;}},async endSession(){}};}};
 registerServiceOperations({app,mongoose,Booking,Worker,Customer:{},requireWorker:guard('worker'),requireCustomer:guard('customer'),requireAdminKey:guard('admin'),wrap,customerFirebaseAuth:null,
  customerLocalPhone:v=>v,signWorkerToken:()=>'',hashPassword:async()=>'',publicWorker:w=>({id:w._id,approvedSkills:w.approvedSkills,online:w.online}),limit:()=>true});
 async function run(method,path,extra={}){
  return new Promise((resolve,reject)=>{const req={role:'worker',worker:clone(worker),customer:{uid:'customer-a'},params:{id:bid},query:{},body:{},...extra};const handlers=routes.get(`${method} ${path}`);assert.ok(handlers,path);let index=0;
   const res={code:200,status(c){this.code=c;return this;},json(data){resolve({code:this.code,data});},set(){},type(){return this;},send(data){resolve({code:this.code,data});}};
   function next(){const handler=handlers[index++];if(!handler)return reject(new Error('No response'));Promise.resolve(handler(req,res,next)).catch(reject);}next();
  });
 }
 return{run,state,worker,calls,app};
}
test('location pins reject malformed and out-of-range coordinates',()=>{
 assert.equal(validPin({latitude:23.83,longitude:91.28}),true);
 for(const value of [null,{}, {latitude:91,longitude:0},{latitude:0,longitude:-181},{latitude:NaN,longitude:1},{latitude:'23',longitude:91}])assert.equal(!!validPin(value),false);
});
test('matching requires approved category, phone, identity, payout and active online shift',()=>{
 const f=fixture();assert.equal(eligible(f.worker,'Plumbing'),true);assert.equal(eligible(f.worker,'AC Repair'),false);
 for(const patch of [{active:false},{hasProfilePhoto:false},{phoneVerified:false},{verificationStatus:'pending'},{payoutSummary:null},{online:false},{availableUntil:new Date(0)}])assert.equal(eligible({...f.worker,...patch},'Plumbing'),false);
});
test('unassigned offers do not reveal customer contact, address, pin or photos',()=>{
 const offer=safeOffer(fixture().state.booking);
 for(const field of ['customerName','phone','customerUid','address','location','problemPhotosEncrypted','completionOtpHash'])assert.equal(offer[field],undefined);
});
test('simultaneous worker claims can produce only one assigned worker',async()=>{
 const f=fixture({booking:{status:'pending',assignedWorkerId:null,dispatchMode:'first_claim',scheduledAt:new Date(Date.now()+3600000)}});
 const other={...f.worker,_id:w2,name:'Worker B'};
 const results=await Promise.all([f.run('post','/api/worker/bookings/:id/claim'),f.run('post','/api/worker/bookings/:id/claim',{worker:other})]);
 assert.deepEqual(results.map(r=>r.code).sort(),[200,409]);assert.equal(f.state.booking.status,'accepted');assert.ok([w1,w2].includes(f.state.booking.assignedWorkerId));
 const filter=f.calls.find(c=>c[0]==='bookingUpdate')[1];assert.equal(filter.assignedWorkerId,null);assert.equal(filter.dispatchMode,'first_claim');
});
test('admin-only dispatch and wrong skill cannot be claimed',async()=>{
 const a=fixture({booking:{status:'pending',assignedWorkerId:null,dispatchMode:'admin_assign'}});assert.equal((await a.run('post','/api/worker/bookings/:id/claim')).code,409);
 const b=fixture({booking:{service:'AC Repair',status:'pending',assignedWorkerId:null,dispatchMode:'first_claim'}});assert.equal((await b.run('post','/api/worker/bookings/:id/claim')).code,403);
});
test('new order notifications target Admin and only matching online workers',async()=>{
 const f=fixture();await f.app.locals.notifyBooking(f.state.booking);
 assert.equal(f.state.notifications.some(n=>n.ownerRole==='admin'),true);assert.equal(f.state.notifications.filter(n=>n.ownerRole==='worker').length,2);
 const other=fixture({worker:{approvedSkills:['AC Repair']}});await other.app.locals.notifyBooking(other.state.booking);assert.equal(other.state.notifications.some(n=>n.ownerRole==='worker'),false);
});
test('only owner can generate completion code; wrong worker cannot consume it',async()=>{
 const f=fixture();assert.equal((await f.run('post','/api/customer/bookings/:id/completion-code',{role:'worker'})).code,401);
 assert.equal((await f.run('post','/api/customer/bookings/:id/completion-code',{role:'customer',customer:{uid:'customer-b'}})).code,409);
 const issued=await f.run('post','/api/customer/bookings/:id/completion-code',{role:'customer'});assert.equal(issued.code,200);assert.match(issued.data.code,/^\d{6}$/);
 assert.notEqual(f.state.booking.completionOtpHash,issued.data.code);assert.equal(f.state.booking.completionOtpHash,completionHash(bid,issued.data.code));
 assert.equal((await f.run('post','/api/worker/bookings/:id/complete',{worker:{...f.worker,_id:w2},body:{code:issued.data.code}})).code,409);
});
test('valid completion code works once and never marks a cash payment paid',async()=>{
 const f=fixture();const issued=await f.run('post','/api/customer/bookings/:id/completion-code',{role:'customer'});
 const done=await f.run('post','/api/worker/bookings/:id/complete',{body:{code:issued.data.code}});assert.equal(done.code,200);assert.equal(f.state.booking.status,'completed');
 assert.equal(f.state.booking.paymentStatus,'pending_collection');assert.equal(f.state.booking.completionOtpHash,undefined);assert.ok(f.state.booking.completionVerifiedAt instanceof Date);
 assert.equal((await f.run('post','/api/worker/bookings/:id/complete',{body:{code:issued.data.code}})).code,409);
});
test('incorrect, expired and over-attempt codes do not complete a service',async()=>{
 const f=fixture();await f.run('post','/api/customer/bookings/:id/completion-code',{role:'customer'});
 for(let i=0;i<5;i++)assert.equal((await f.run('post','/api/worker/bookings/:id/complete',{body:{code:'000000'}})).code,400);
 assert.equal((await f.run('post','/api/worker/bookings/:id/complete',{body:{code:'000000'}})).code,429);assert.equal(f.state.booking.status,'accepted');
 f.state.booking.completionOtpAttempts=0;f.state.booking.completionOtpExpiresAt=new Date(0);assert.equal((await f.run('post','/api/worker/bookings/:id/complete',{body:{code:'000000'}})).code,410);
});
test('completion code issue has cooldown and result evidence requirement',async()=>{
 const f=fixture();assert.equal((await f.run('post','/api/customer/bookings/:id/completion-code',{role:'customer'})).code,200);
 assert.equal((await f.run('post','/api/customer/bookings/:id/completion-code',{role:'customer'})).code,409);
 const missing=fixture({booking:{completionRequestedAt:null}});assert.equal((await missing.run('post','/api/customer/bookings/:id/completion-code',{role:'customer'})).code,409);
});
test('order and photo details remain owner/assigned-worker only, with no OTP hash in DTO',async()=>{
 const f=fixture();assert.equal((await f.run('get','/api/worker/bookings/:id/photos',{worker:{...f.worker,_id:w2}})).code,404);
 assert.equal((await f.run('get','/api/customer/bookings/:id/photos',{role:'customer',customer:{uid:'other'}})).code,404);
 assert.deepEqual((await f.run('get','/api/customer/bookings/:id/photos',{role:'customer'})).data,{problem:['problem-image'],result:['result-image']});
 const dto=(await f.run('get','/api/worker/bookings/:id')).data.booking;assert.equal(dto.completionOtpHash,undefined);assert.equal(dto.problemPhotosEncrypted,undefined);assert.equal(dto.workerSettlement,undefined);
});
test('reviews require completed owner verification and are accepted only once',async()=>{
 const f=fixture();assert.equal((await f.run('post','/api/customer/bookings/:id/review',{role:'customer',body:{stars:5,comment:'Good work'}})).code,409);
 f.state.booking.status='completed';f.state.booking.completionVerifiedAt=new Date();
 assert.equal((await f.run('post','/api/customer/bookings/:id/review',{role:'customer',body:{stars:6}})).code,400);
 assert.equal((await f.run('post','/api/customer/bookings/:id/review',{role:'customer',body:{stars:5,comment:'Good work',public:false}})).code,201);
 assert.equal((await f.run('post','/api/customer/bookings/:id/review',{role:'customer',body:{stars:1,comment:'duplicate'}})).code,409);assert.equal(f.state.reviews.length,1);
 assert.equal(f.state.booking.review.public,false);
});
test('public reviews omit account, booking, name and phone identifiers',async()=>{
 const f=fixture();f.state.reviews.push({bookingId:bid,customerUid:'customer-a',service:'Plumbing',stars:5,comment:'Good work',public:true,createdAt:new Date()});
 const result=await f.run('get','/api/services/reviews',{role:'customer',query:{service:'Plumbing'}});
 const review=result.data.reviews[0];assert.equal(review.customerUid,undefined);assert.equal(review.bookingId,undefined);assert.equal(review.stars,5);
});
test('support tickets bind to authenticated owner and enforce order ownership',async()=>{
 const f=fixture();assert.equal((await f.run('post','/api/customer/support',{role:'customer',body:{subject:'Help',message:'Need help with the service',bookingId:bid},customer:{uid:'other'}})).code,404);
 assert.equal((await f.run('post','/api/customer/support',{role:'customer',body:{subject:'Help',message:'Need help with the service',ownerId:'attacker'}})).code,201);
 assert.equal(f.state.tickets[0].ownerId,'customer-a');assert.equal(f.state.tickets[0].messages[0].role,'customer');
});

test('booking creation stores the authenticated owner, canonical IST schedule and private photos',async()=>{
 const fs=require('fs'),vm=require('vm');const source=fs.readFileSync(require.resolve('./server'),'utf8');
 const start=source.indexOf("app.post('/api/bookings',"),end=source.indexOf('// Connect to MongoDB',start);
 let handler,payload,alerts=0;
 const app={locals:{notifyBooking:async()=>{alerts++;}},post(_path,_guard,route){handler=route;}};
 const code=source.slice(start,end);
 const context={app,requireCustomer:()=>{},Booking:{async create(body){payload=body;return body;}},mongoose:{Types:{ObjectId:class{toString(){return bid;}}}},
  customerLocalPhone:p=>p?.match(/^\+91([6-9]\d{9})$/)?.[1]||'',Date,console:{error(){}},require:path=>path==='./service-operations'?require('./service-operations'):require('./business-tools')};
 vm.runInNewContext(code,context);
 async function request(body,phone='+919999999999'){
  payload=null;return new Promise((resolve,reject)=>{const res={code:200,status(c){this.code=c;return this;},json(data){resolve({code:this.code,data});}};
   Promise.resolve(handler({body,customer:{uid:'customer-a',phoneNumber:phone}},res)).catch(reject);});
 }
 const scheduledAt=new Date(Date.now()+86400000).toISOString();const base={customerName:'Test Customer',phone:'9999999999',address:'Test address',service:'Plumbing',date:'untrusted date',time:'untrusted time',scheduledAt,termsVersion:'2026-10-30-v5',clientFeatureVersion:4,customerUid:'attacker',paymentStatus:'paid',quotedAmountPaise:1};
 assert.equal((await request({...base,location:{latitude:23.83,longitude:91.28}})).code,201);
 assert.equal(payload.customerUid,'customer-a');assert.equal(payload.paymentStatus,undefined);assert.equal(payload.quotedAmountPaise,undefined);assert.equal(payload.dispatchMode,'first_claim');
 const ist=new Date(new Date(scheduledAt).getTime()+330*60000);assert.equal(payload.date,ist.toISOString().slice(0,10));assert.match(payload.time,/^\d{2}:\d{2} IST$/);assert.equal(alerts,1);
 assert.equal((await request({...base,location:{latitude:91,longitude:91}})).code,400);assert.equal(payload,null);
 assert.equal((await request({...base,scheduledAt:'2000-01-01T00:00:00Z'})).code,400);
 assert.equal((await request({...base,termsVersion:'old'})).code,400);
 assert.equal((await request(base,'+449999999999')).code,403);
 const legacy={...base};delete legacy.clientFeatureVersion;delete legacy.termsVersion;delete legacy.scheduledAt;
 assert.equal((await request(legacy)).code,201);assert.equal(payload.dispatchMode,'admin_assign');assert.equal(payload.termsVersion,'legacy-not-recorded');
});

test('revoked identity approval blocks direct job and private photo links',async()=>{
 for(const patch of [{phoneVerified:false},{verificationStatus:'rejected'},{payoutSummary:null}]){
  const f=fixture({worker:patch});
  for(const path of ['/api/worker/bookings/:id','/api/worker/bookings/:id/photos']){
   const result=await f.run('get',path);assert.equal(result.code,403);
   assert.equal(JSON.stringify(result.data).includes('Private address'),false);
  }
 }
});
