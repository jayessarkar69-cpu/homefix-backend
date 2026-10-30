'use strict';
const crypto=require('crypto');
const EVENTS=['booking','assignment','price_updated','price_accepted','payment_received','completed','started','cancelled','completion_code'];
function smsConfig(env=process.env){return{ready:env.HOMEFIX_SMS_ENABLED==='true'&&!!env.MSG91_AUTH_KEY&&EVENTS.every(e=>!!env[`MSG91_TEMPLATE_${e.toUpperCase()}`]),provider:'MSG91',events:EVENTS.map(event=>({event,configured:!!env[`MSG91_TEMPLATE_${event.toUpperCase()}`]}))};}
function registerServiceSms({app,mongoose,Customer,requireCustomer,requireAdminKey,wrap}){
 const Delivery=mongoose.models.ServiceSmsDelivery||mongoose.model('ServiceSmsDelivery',new mongoose.Schema({eventKey:{type:String,unique:true},event:String,bookingId:String,status:String,phoneLast4:String},{timestamps:true}));
 app.locals.smsReady=()=>smsConfig().ready;
 app.locals.sendServiceSms=async(booking,event,extra={})=>{
  if(!EVENTS.includes(event)||!smsConfig().ready)return'not_configured';
  const customer=await Customer.findOne({firebaseUid:booking.customerUid,smsUpdates:true}).lean();
  const phone=String(customer?.phone||'').replace(/\D/g,'');
  if(!customer||!/^91[6-9]\d{9}$/.test(phone)||phone.slice(-10)!==String(booking.phone).replace(/\D/g,'').slice(-10))return'not_opted_in';
  const suffix=extra.eventKey||`${booking.paymentUpdatedAt||booking.updatedAt||booking.assignedAt||booking.createdAt||''}:${booking.quotedAmountPaise||0}`;
  const eventKey=crypto.createHash('sha256').update(`${booking._id}:${event}:${suffix}`).digest('hex');
  let log;try{log=await Delivery.create({eventKey,event,bookingId:String(booking._id),status:'pending',phoneLast4:phone.slice(-4)});}catch(error){if(error.code===11000)return'already_requested';throw error;}
  try{
   const response=await fetch('https://control.msg91.com/api/v5/flow',{method:'POST',headers:{authkey:process.env.MSG91_AUTH_KEY,'Content-Type':'application/json'},signal:AbortSignal.timeout(5000),body:JSON.stringify({template_id:process.env[`MSG91_TEMPLATE_${event.toUpperCase()}`],short_url:'0',recipients:[{mobiles:phone,booking:String(booking._id),service:booking.service,date:booking.date,time:booking.time,price:((booking.quotedAmountPaise||0)/100).toFixed(2),...(event==='completion_code'?{code:extra.code}:{})}]})});
   const result=await response.json();const status=response.ok&&result.type==='success'?'accepted':'failed';await Delivery.updateOne({_id:log._id},{$set:{status}});return status;
  }catch(_){await Delivery.updateOne({_id:log._id},{$set:{status:'failed'}});return'failed';}
 };
 app.get('/api/customer/preferences',requireCustomer,wrap(async(req,res)=>{const c=await Customer.findOne({firebaseUid:req.customer.uid}).lean();res.json({smsUpdates:c?.smsUpdates===true,smsReady:smsConfig().ready});}));
 app.patch('/api/customer/preferences',requireCustomer,wrap(async(req,res)=>{
  if(typeof req.body?.smsUpdates!=='boolean')return res.status(400).json({message:'Choose SMS updates on or off.'});
  await Customer.findOneAndUpdate({firebaseUid:req.customer.uid},{$set:{smsUpdates:req.body.smsUpdates,smsConsentAt:new Date(),phone:req.customer.phoneNumber},$setOnInsert:{firebaseUid:req.customer.uid}},{upsert:true});res.json({smsUpdates:req.body.smsUpdates,smsReady:smsConfig().ready});
 }));
 app.get('/api/admin/sms-status',requireAdminKey,wrap(async(req,res)=>res.json(smsConfig())));
}
module.exports={registerServiceSms,smsConfig};
