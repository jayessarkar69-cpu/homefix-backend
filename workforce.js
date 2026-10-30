'use strict';
const {validateImage,walletView}=require('./business-tools');
const IST=330*60000,DAY=86400000;
function periodStarts(now=new Date()){
 const local=new Date(+now+IST),day=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-IST;
 return {today:new Date(day),week:new Date(day-((local.getUTCDay()+6)%7)*DAY),month:new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),1)-IST)};
}
function activitySummary(rows,now=new Date()){
 const intervals=rows.map(row=>[Math.max(+new Date(row.startedAt),+now-90*DAY),Math.min(+new Date(row.endedAt||row.expiresAt),+new Date(row.expiresAt),+now)]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0]);
 const merged=[];for(const pair of intervals){const last=merged.at(-1);if(last&&pair[0]<=last[1])last[1]=Math.max(last[1],pair[1]);else merged.push(pair);}
 let millis=0;const days=new Set();for(const [start,end] of merged){millis+=end-start;for(let cursor=start;cursor<end;cursor=(Math.floor((cursor+IST)/DAY)+1)*DAY-IST)days.add(new Date(cursor+IST).toISOString().slice(0,10));}
 return{onlineMinutes:Math.round(millis/60000),onlineDays:days.size,windowDays:90};
}
function registerWorkforce({app,mongoose,Worker,Booking,requireWorker,requireCustomer,requireAdminKey,wrap,publicWorker}){
 const Shift=mongoose.models.WorkerShift||mongoose.model('WorkerShift',new mongoose.Schema({workerId:{type:mongoose.Schema.Types.ObjectId,index:true},startedAt:Date,expiresAt:Date,endedAt:Date,lastSeenAt:Date},{timestamps:true}));
 const Review=mongoose.models.ServiceReview,Settlement=mongoose.models.WorkerSettlement;
 async function shift(worker,online){
  const now=new Date();
  if(!online){await Shift.updateMany({workerId:worker._id,endedAt:null},{$set:{endedAt:now,lastSeenAt:now}});return;}
  const active=await Shift.findOne({workerId:worker._id,endedAt:null,expiresAt:{$gt:now}});
  if(active){await Shift.updateOne({_id:active._id},{$set:{expiresAt:worker.availableUntil,lastSeenAt:now}});return;}
  await Shift.create({workerId:worker._id,startedAt:now,expiresAt:worker.availableUntil,lastSeenAt:now});
 }
 app.locals.recordWorkerShift=shift;
 async function profile(worker,privateView=false){
  const since=new Date(Date.now()-90*DAY),starts=periodStarts();
  const [rating,completed,workRows,shifts,earnings]=await Promise.all([
   Review.aggregate([{$match:{workerId:worker._id,workerStars:{$gte:1}}},{$group:{_id:null,average:{$avg:'$workerStars'},count:{$sum:1}}}]),
   Booking.countDocuments({assignedWorkerId:worker._id,status:'completed'}),
   privateView?Booking.find({assignedWorkerId:worker._id,status:'completed',completedAt:{$gte:since},workStartedAt:{$ne:null}}).select('workStartedAt completedAt').lean():[],
   privateView?Shift.find({workerId:worker._id,expiresAt:{$gte:since}}).sort({startedAt:1}).lean():[],
   privateView?Settlement.find({workerId:worker._id,createdAt:{$gte:new Date(Math.min(+starts.week,+starts.month))}}).select('earningsPaise grossPaise commissionPaise createdAt').lean():[],
  ]);
  const result={worker:publicWorker(worker),rating:{average:rating[0]?.average||0,count:rating[0]?.count||0},completedServices:completed,photoData:worker.profilePhotoData||null};
  if(privateView){result.wallet=walletView(worker);const periods={};for(const [key,start] of Object.entries(starts)){const rows=earnings.filter(r=>new Date(r.createdAt)>=start);periods[key]={earnedPaise:rows.reduce((v,r)=>v+(r.earningsPaise||0),0),grossPaise:rows.reduce((v,r)=>v+(r.grossPaise||0),0),commissionPaise:rows.reduce((v,r)=>v+(r.commissionPaise||0),0),jobs:rows.length};}
   result.periods=periods;result.activity=activitySummary(shifts);result.activity.serviceMinutes=workRows.reduce((v,r)=>v+Math.max(0,Math.round((+new Date(r.completedAt)-+new Date(r.workStartedAt))/60000)),0);
   result.activity.lastSeenAt=worker.lastSeenAt||null;result.activity.online=worker.online===true&&new Date(worker.availableUntil)>new Date();
  }
  return result;
 }
 app.get('/api/worker/profile',requireWorker,wrap(async(req,res)=>{
  const worker=await Worker.findById(req.worker._id).select('+profilePhotoData').lean();res.json(await profile(worker,true));
 }));
 app.patch('/api/worker/profile',requireWorker,wrap(async(req,res)=>{
  const name=String(req.body?.name||'').trim(),photo=req.body?.photoData;
  if(!name||name.length>100||(photo!==undefined&&!validateImage(photo,250000)))return res.status(400).json({message:'Enter your name and a JPEG/PNG profile photo below 250 KB.'});
  const worker=await Worker.findOneAndUpdate({_id:req.worker._id,active:true},{$set:{name,...(photo?{profilePhotoData:photo,hasProfilePhoto:true}:{})}},{new:true});
  res.json({worker:publicWorker(worker),message:'Profile updated.'});
 }));
 app.post('/api/worker/heartbeat',requireWorker,wrap(async(req,res)=>{
  const now=new Date();const worker=await Worker.findOneAndUpdate({_id:req.worker._id,active:true},{$set:{lastSeenAt:now}},{new:true});
  if(worker.online&&(new Date(worker.availableUntil)<=now||!worker.hasProfilePhoto||!worker.phoneVerified||worker.verificationStatus!=='approved'||!worker.payoutSummary)){worker.online=false;await Worker.updateOne({_id:worker._id},{$set:{online:false}});}
  await Shift.updateMany({workerId:worker._id,endedAt:null,expiresAt:{$gt:now}},{$set:{lastSeenAt:now}});
  res.json({online:worker.online===true,availableUntil:worker.availableUntil,lastSeenAt:now,needsProfilePhoto:!worker.hasProfilePhoto});
 }));
 app.get('/api/admin/workers/:id/profile',requireAdminKey,wrap(async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid worker.'});
  const worker=await Worker.findById(req.params.id).select('+profilePhotoData').lean();if(!worker)return res.status(404).json({message:'Worker not found.'});res.json(await profile(worker,true));
 }));
 app.get('/api/customer/bookings/:id/worker',requireCustomer,wrap(async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid order.'});
  const booking=await Booking.findOne({_id:req.params.id,customerUid:req.customer.uid});
  if(!booking?.assignedWorkerId)return res.status(404).json({message:'No worker assigned.'});
  const worker=await Worker.findById(booking.assignedWorkerId).select('+profilePhotoData').lean();if(!worker)return res.status(404).json({message:'Worker not found.'});
  const result=await profile(worker,false);result.worker={id:String(worker._id),name:worker.name,approvedSkills:worker.approvedSkills||[],verificationStatus:worker.verificationStatus};res.json(result);
 }));
 app.post('/api/worker/bookings/:id/price-accept',requireWorker,wrap(async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id)||!Number.isSafeInteger(req.body?.amountPaise)||!['percent','fixed'].includes(req.body?.commissionMode)||!Number.isFinite(req.body?.commissionValue))return res.status(400).json({message:'Invalid price.'});
  const booking=await Booking.findOneAndUpdate({_id:req.params.id,assignedWorkerId:req.worker._id,status:{$in:['pending','accepted']},quotedAmountPaise:req.body.amountPaise,commissionMode:req.body.commissionMode==="percent"?{$in:["percent",null]}:req.body.commissionMode,commissionValue:req.body.commissionValue===20?{$in:[20,null]}:req.body.commissionValue,workStartedAt:null},{$set:{workerPriceAcceptedAt:new Date(),workerAcceptedPricePaise:req.body.amountPaise,commissionMode:req.body.commissionMode,commissionValue:req.body.commissionValue},$inc:{__v:1}},{new:true});
  if(!booking)return res.status(409).json({message:'Service price changed. Refresh before approving.'});
  await app.locals.notifyServiceEvent?.(booking,'price_accepted');res.json({accepted:true});
 }));
}
module.exports={registerWorkforce,periodStarts,activitySummary};
