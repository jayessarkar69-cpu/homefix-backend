'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {encryptPrivate,decryptPrivate,validateImage,settlementAmounts,walletView,registerBusinessTools}=require('./business-tools');
process.env.PRIVATE_DATA_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64');
test('private identity and payout data are authenticated ciphertext, not readable database fields',()=>{
 const original={holderName:'Test Worker',upi:'worker@test',documentImage:'private-test'};
 const a=encryptPrivate(original),b=encryptPrivate(original);
 assert.notEqual(a.data,b.data);assert.equal(JSON.stringify(a).includes('worker@test'),false);
 assert.deepEqual(decryptPrivate(a),original);
 const bound=encryptPrivate(original,'worker-a');assert.throws(()=>decryptPrivate(bound,'worker-b'));assert.deepEqual(decryptPrivate(bound,'worker-a'),original);
 a.data=Buffer.from('tampered').toString('base64');assert.throws(()=>decryptPrivate(a));
});
test('commission handles percent and fixed amount in integer paise',()=>{
 assert.deepEqual(settlementAmounts(50000,'percent',20),{grossPaise:50000,commissionPaise:10000,earningsPaise:40000});
 assert.deepEqual(settlementAmounts(49999,'percent',20),{grossPaise:49999,commissionPaise:10000,earningsPaise:39999});
 assert.deepEqual(settlementAmounts(50000,'fixed',7500),{grossPaise:50000,commissionPaise:7500,earningsPaise:42500});
 for(const [mode,value] of [['fixed',50001],['percent',101],['percent',-1],['fixed',1.5],['unknown',20]])assert.throws(()=>settlementAmounts(50000,mode,value));
});
test('cash collection offsets income and cannot create a second withdrawable payment',()=>{
 const amounts=settlementAmounts(50000,'percent',20);
 const cash=walletView({wallet:{earnedPaise:amounts.earningsPaise,cashHeldPaise:50000,balancePaise:amounts.earningsPaise-50000}});
 assert.equal(cash.availablePaise,0);assert.equal(cash.owesHomeFixPaise,10000);
 const online=walletView({wallet:{earnedPaise:40000,balancePaise:40000,reservedPaise:15000}});
 assert.equal(online.availablePaise,25000);assert.equal(online.owesHomeFixPaise,0);
});
test('image uploads accept only supported headers and bounded sizes',()=>{
 const png='data:image/png;base64,'+Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64');
 assert.equal(validateImage(png),true);assert.equal(validateImage(png,8),false);
 assert.equal(validateImage('data:image/svg+xml;base64,PHN2Zz4='),false);
 assert.equal(validateImage('https://unsafe.invalid/id.jpg'),false);
 assert.equal(validateImage('data:image/jpeg;base64,'+Buffer.from('not an image').toString('base64')),false);
});
function routesFixture({worker={_id:'123456789012345678901234',verificationStatus:'approved',payoutEncrypted:encryptPrivate({method:'upi',upi:'worker@test'}),payoutSummary:'UPI test',wallet:{balancePaise:40000,reservedPaise:0}},withdrawal=null,modify=1}={}){
 const routes=new Map(),calls=[];
 const chain=value=>({select(){return this;},session(){return Promise.resolve(value);},then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
 const Worker={findById(){return chain(worker);},async updateOne(filter,update){calls.push(['workerUpdate',filter,update]);return{modifiedCount:modify};}};
 const Withdrawal={async init(){},async create(records){calls.push(['withdrawalCreate',records]);return[{_id:'withdrawal-test',...records[0]}];},
  findOneAndUpdate(filter,update){calls.push(['withdrawalUpdate',filter,update]);return chain(withdrawal);}};
 const app={};for(const method of ['get','post','patch','delete'])app[method]=(path,...handlers)=>routes.set(method+' '+path,handlers);
 const mongoose={Schema:class{static Types={ObjectId:String,Mixed:Object};},models:{BusinessSettings:{},WorkerWithdrawal:Withdrawal,WorkerSettlement:{async init(){}},WorkerRemittance:{async init(){}}},
  async startSession(){return{async withTransaction(fn){return fn();},async endSession(){}};},isValidObjectId:v=>/^[a-f0-9]{24}$/.test(v||'')};
 const guard=(req,res,next)=>req.authorized?next():res.status(401).json({message:'Unauthorized'});
 const wrap=fn=>async(req,res,next)=>{try{await fn(req,res,next);}catch(_){res.status(500).json({message:'Internal error'});}};
 registerBusinessTools({app,mongoose,Booking:{},Worker,Customer:{},requireAdminKey:guard,requireWorker:guard,requireCustomer:guard,wrap,
  hashPassword:async()=>'',publicWorker:v=>v,limit:()=>true});
 async function run(method,path,req={}){return new Promise((resolve,reject)=>{
  const handlers=routes.get(method+' '+path);let i=0;
  const res={code:200,status(c){this.code=c;return this;},json(data){resolve({code:this.code,data});},set(){}};
  function next(){Promise.resolve(handlers[i++]({...req,body:req.body||{},params:req.params||{},worker:{_id:'123456789012345678901234'}},res,next)).catch(reject);}next();
 });}
 return{run,calls};
}
test('withdrawals require role, verified identity, payout destination and enough available funds',async()=>{
 for(const options of [{worker:null},{worker:{verificationStatus:'pending'}},{worker:{verificationStatus:'approved',payoutEncrypted:null}},
 {worker:{verificationStatus:'approved',payoutEncrypted:{},wallet:{balancePaise:-10000}}}]){
  const f=routesFixture(options);const res=await f.run('post','/api/worker/withdrawals',{authorized:true,body:{amountPaise:10000}});
  assert.equal(res.code,409);assert.equal(f.calls.length,0);
 }
 const f=routesFixture();assert.equal((await f.run('post','/api/worker/withdrawals')).code,401);
 for(const amount of [0,-1,1.2,NaN,Infinity])assert.equal((await f.run('post','/api/worker/withdrawals',{authorized:true,body:{amountPaise:amount}})).code,400);
});
test('withdrawal reserves balance atomically and snapshots payout instructions privately',async()=>{
 const f=routesFixture();const res=await f.run('post','/api/worker/withdrawals',{authorized:true,body:{amountPaise:10000}});
 assert.equal(res.code,201);const reservation=f.calls.find(c=>c[0]==='workerUpdate');
 assert.equal(reservation[2].$inc['wallet.reservedPaise'],10000);assert.ok(reservation[1].$expr);
 assert.equal(res.data.withdrawal.payoutSnapshot,undefined);assert.equal(res.data.withdrawal.amountPaise,10000);
 const race=routesFixture({modify:0});assert.equal((await race.run('post','/api/worker/withdrawals',{authorized:true,body:{amountPaise:10000}})).code,409);
 assert.equal(race.calls.some(c=>c[0]==='withdrawalCreate'),false);
});
test('paid withdrawals require transfer reference and only process requested records',async()=>{
 const f=routesFixture();const id='abcdefabcdefabcdefabcdef';
 assert.equal((await f.run('patch','/api/admin/withdrawals/:id',{authorized:true,params:{id},body:{status:'paid'}})).code,400);
 assert.equal((await f.run('patch','/api/admin/withdrawals/:id',{authorized:true,params:{id},body:{status:'paid',reference:'TRANSFER-1'}})).code,409);
 const call=f.calls.find(c=>c[0]==='withdrawalUpdate');assert.equal(call[1].status,'requested');
});
