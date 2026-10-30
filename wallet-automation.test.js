'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {registerBusinessTools}=require('./business-tools');
const id='abcdefabcdefabcdefabcdef',wid='111111111111111111111111';
function fixture(patch={}){
 let state={booking:{_id:id,assignedWorkerId:wid,status:'completed',paymentStatus:'paid',quotedAmountPaise:50000,commissionMode:'percent',commissionValue:20,completionVerifiedAt:new Date(),workerPriceAcceptedAt:new Date(),paymentMethod:'razorpay',service:'Plumbing',...patch},worker:{_id:wid,verificationStatus:'approved',wallet:{}},records:[]};
 const routes=new Map(),app={locals:{}};for(const m of ['get','post','patch','delete'])app[m]=(p,...h)=>routes.set(m+' '+p,h);
 const at=(o,p)=>p.split('.').reduce((v,k)=>v?.[k],o);
 function matches(f){return Object.entries(f).every(([k,v])=>{const value=at(state.booking,k);return v===null?value==null:v&&typeof v==='object'&&'$ne'in v?v.$ne===null?value!=null:value!==v.$ne:value===v;});}
 function query(doc){return{session:async()=>doc,select(){return this;},lean:async()=>doc,then(r,j){return Promise.resolve(doc).then(r,j);}};}
 function booking(){const v=structuredClone(state.booking);v.save=async()=>{const {save,...saved}=v;state.booking=saved;};return v;}
 const Booking={findOne:f=>query(matches(f)?booking():null)};
 const Worker={findById:()=>query(structuredClone(state.worker)),async updateOne(f,u){for(const [k,v] of Object.entries(u.$inc)){const key=k.replace('wallet.','');state.worker.wallet[key]=(state.worker.wallet[key]||0)+v;}return{modifiedCount:1};}};
 const Settlement={async init(){},async create(records){if(state.records.length){const e=new Error('duplicate');e.code=11000;throw e;}state.records.push(...structuredClone(records));return records;}};
 let lock=Promise.resolve();const mongoose={models:{BusinessSettings:{},WorkerSettlement:Settlement,WorkerWithdrawal:{async init(){}},WorkerRemittance:{async init(){}},WorkerShift:{},ServiceSmsDelivery:{}},Schema:class{static Types={Mixed:Object,ObjectId:String};},isValidObjectId:v=>/^[a-f0-9]{24}$/.test(v||''),async startSession(){return{async withTransaction(fn){const old=lock;let release;lock=new Promise(r=>release=r);await old;const before=structuredClone(state);try{return await fn();}catch(e){state=before;throw e;}finally{release();}},async endSession(){}};}};
 const guard=(q,s,next)=>next();const wrap=fn=>async(q,s,n)=>{try{await fn(q,s,n);}catch(e){s.status(500).json({error:e.name});}};
 registerBusinessTools({app,mongoose,Booking,Worker,Customer:{},requireAdminKey:guard,requireCustomer:guard,requireWorker:guard,wrap,publicWorker:v=>v,hashPassword:async()=>'',limit:()=>true});
 async function manual(body){return new Promise((resolve,reject)=>{let i=0;const handlers=routes.get('post /api/admin/bookings/:id/settlement'),q={params:{id},body};const s={code:200,status(n){this.code=n;return this;},json(v){resolve({code:this.code,data:v});}};function next(){Promise.resolve(handlers[i++](q,s,next)).catch(reject);}next();});}
 return{auto:()=>app.locals.autoSettle(id),manual,get state(){return state;}};
}
test('automatic wallet credit deducts agreed commission exactly once',async()=>{const f=fixture();await f.auto();await f.auto();assert.equal(f.state.records.length,1);assert.equal(f.state.worker.wallet.earnedPaise,40000);assert.equal(f.state.worker.wallet.commissionPaise,10000);assert.equal(f.state.worker.wallet.balancePaise,40000);});
test('concurrent completion and payment hooks cannot double-credit wallet',async()=>{const f=fixture();await Promise.all([f.auto(),f.auto()]);assert.equal(f.state.records.length,1);assert.equal(f.state.worker.wallet.balancePaise,40000);});
test('worker-held cash offsets balance while commission remains owed',async()=>{const f=fixture({paymentMethod:'cash_on_service',cashCollection:{status:'customer_confirmed',workerId:wid}});await f.auto();assert.equal(f.state.worker.wallet.earnedPaise,40000);assert.equal(f.state.worker.wallet.cashHeldPaise,50000);assert.equal(f.state.worker.wallet.balancePaise,-10000);});
test('unpaid, unverified and unapproved-price orders never receive automatic earnings',async()=>{for(const patch of [{paymentStatus:'pending_collection'},{completionVerifiedAt:null},{workerPriceAcceptedAt:null},{status:'accepted'}]){const f=fixture(patch);await f.auto();assert.equal(f.state.records.length,0);}});
test('Admin cannot change an already worker-approved commission at settlement',async()=>{const f=fixture();const result=await f.manual({mode:'percent',value:40});assert.equal(result.code,409);assert.equal(f.state.records.length,0);assert.deepEqual(f.state.worker.wallet,{});});
