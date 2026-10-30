'use strict';
const crypto = require('crypto');
const { encryptPrivate, decryptPrivate, validateImage } = require('./business-tools');
const SERVICES = ['Plumbing','Electrician','AC Repair','Appliance Repair','Home Cleaning','Painting'];
const POLICY_VERSION = '2026-10-30-v4';
function validPin(pin) {
  return pin && typeof pin.latitude === 'number' && typeof pin.longitude === 'number' &&
    Number.isFinite(pin.latitude) && Number.isFinite(pin.longitude) && Math.abs(pin.latitude) <= 90 && Math.abs(pin.longitude) <= 180;
}
function eligible(worker, service, now = new Date()) {
  return !!(worker?.active && worker.phoneVerified && worker.verificationStatus === 'approved' && worker.payoutSummary &&
    worker.online && new Date(worker.availableUntil) > now && worker.approvedSkills?.includes(service));
}
function completionHash(id, code) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('Completion verification is not configured');
  return crypto.createHmac('sha256', secret).update(`completion:${String(id).toLowerCase()}:${code}`).digest('hex');
}
function safeOffer(booking) {
  return { bookingId: String(booking._id), service: booking.service, date: booking.date, time: booking.time,
    scheduledAt: booking.scheduledAt, createdAt: booking.createdAt, dispatchMode: booking.dispatchMode || 'admin_assign',
    area: 'Agartala', quotedAmountPaise: booking.quotedAmountPaise ?? null };
}
function imagesValid(images) { return Array.isArray(images) && images.length >= 1 && images.length <= 3 && images.every(v => validateImage(v, 400000)); }
function registerServiceOperations({ app, mongoose, Booking, Worker, Customer, requireWorker, requireCustomer,
  requireAdminKey, wrap, customerFirebaseAuth, customerLocalPhone, signWorkerToken, hashPassword, publicWorker, limit }) {
  const Notification = mongoose.models.AppNotification || mongoose.model('AppNotification', new mongoose.Schema({
    ownerRole: { type: String, required: true }, ownerId: { type: String, required: true }, title: String, body: String,
    kind: String, bookingId: String, eventKey: String, readAt: Date,
  }, { timestamps: true }));
  Notification.schema.index({ ownerRole: 1, ownerId: 1, createdAt: -1 });
  const Device = mongoose.models.AppDevice || mongoose.model('AppDevice', new mongoose.Schema({
    tokenHash: { type: String, unique: true }, encryptedToken: { type: mongoose.Schema.Types.Mixed, select: false },
    ownerRole: String, ownerId: String, lastSeenAt: Date, targetType: { type: String, enum: ['fid','token'], default: 'fid' },
  }));
  const Ticket = mongoose.models.SupportTicket || mongoose.model('SupportTicket', new mongoose.Schema({
    ownerRole: String, ownerId: { type: String, index: true }, bookingId: mongoose.Schema.Types.ObjectId,
    subject: String, status: { type: String, default: 'open' },
    messages: [{ _id: false, role: String, text: String, createdAt: Date }],
    photoEncrypted: { type: mongoose.Schema.Types.Mixed, select: false },
  }, { timestamps: true }));
  const Review = mongoose.models.ServiceReview || mongoose.model('ServiceReview', new mongoose.Schema({
    bookingId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    customerUid: { type: String, index: true }, service: String, stars: { type: Number, min: 1, max: 5 },
    comment: { type: String, maxlength: 1500 }, public: { type: Boolean, default: false },
  }, { timestamps: true }));
  async function notify(role, ids, title, body, kind, bookingId, eventKey) {
    ids = [...new Set(ids.map(String))];
    if (!ids.length) return;
    await Notification.insertMany(ids.map(ownerId => ({ ownerRole: role, ownerId, title, body, kind,
      bookingId: bookingId ? String(bookingId) : null, eventKey })), { ordered: false });
    const devices = await Device.find({ ownerRole: role, ownerId: { $in: ids }, lastSeenAt: { $gt: new Date(Date.now()-60*86400000) } }).select('+encryptedToken').lean();
    const targets = devices.map(d => { try { return { value: decryptPrivate(d.encryptedToken, `device:${d.tokenHash}`), type: d.targetType || 'fid' }; } catch (_) { return null; } }).filter(v => v?.value);
    if (!targets.length) return;
    try {
      const messaging = require('firebase-admin/messaging').getMessaging();
      for (let i=0; i<targets.length; i+=500) { const batch=targets.slice(i,i+500); await messaging.sendEachForMulticast({ fids: batch.filter(t=>t.type==='fid').map(t=>t.value), tokens: batch.filter(t=>t.type==='token').map(t=>t.value),
        notification: { title, body }, data: { kind, bookingId: bookingId ? String(bookingId) : '' },
        android: { priority: 'high', notification: { channelId: 'homefix_orders' } } }); }
    } catch (_) { /* The in-app inbox remains available if push is unavailable. */ }
  }
  const quietNotify = (...args) => notify(...args).catch(() => {});
  async function notifyBooking(booking) {
    const workers = await Worker.find({ active: true, phoneVerified: true, verificationStatus: 'approved',
      payoutSummary: { $exists: true, $nin: [null,''] }, online: true, availableUntil: { $gt: new Date() }, approvedSkills: booking.service }).select('_id').lean();
    await Promise.all([
      quietNotify('admin',['admin'],'New service booking',`${booking.service} · ${booking.date} · ${booking.time}`,'new_booking',booking._id),
      quietNotify('worker',workers.map(w=>w._id),'New matching order',`${booking.service} · ${booking.date}. Open HomeFix to view availability.`,'job_offer',booking._id),
    ]);
  }
  app.locals.notifyBooking = notifyBooking;
  app.locals.notifyAssignment = booking => quietNotify('worker',[booking.assignedWorkerId],'A job was assigned to you',`${booking.service} · ${booking.date}. Open your assigned jobs.`,'assignment',booking._id);
  function owner(req, role) { return role === 'admin' ? 'admin' : role === 'worker' ? String(req.worker._id) : req.customer.uid; }
  for (const [role, guard] of [['customer',requireCustomer],['worker',requireWorker],['admin',requireAdminKey]]) {
    app.post(`/api/${role}/devices`, guard, wrap(async(req,res)=>{
      const token=req.body?.token;
      if(typeof token!=='string'||token.length<20||token.length>4096)return res.status(400).json({message:'Invalid notification registration.'});
      const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
      const existing = await Device.exists({ tokenHash });
      if (!existing && await Device.countDocuments({ ownerRole: role, ownerId: owner(req, role), lastSeenAt: { $gt: new Date(Date.now()-60*86400000) } }) >= 10) return res.status(429).json({ message: 'Notification device limit reached. Contact support.' });
      await Device.findOneAndUpdate({tokenHash},{$set:{ownerRole:role,ownerId:owner(req,role),lastSeenAt:new Date(),targetType:req.body.registrationType==='token'?'token':'fid',
        encryptedToken:encryptPrivate(token,`device:${tokenHash}`)}},{upsert:true});
      res.json({registered:true});
    }));
    app.delete(`/api/${role}/devices`,guard,wrap(async(req,res)=>{
      const tokenHash=crypto.createHash('sha256').update(String(req.body?.token||'')).digest('hex');
      await Device.deleteOne({tokenHash,ownerRole:role,ownerId:owner(req,role)});res.json({removed:true});
    }));
    app.get(`/api/${role}/notifications`,guard,wrap(async(req,res)=>{
      const page=Math.max(1,Number.parseInt(req.query.page,10)||1),filter={ownerRole:role,ownerId:owner(req,role)};
      const [notifications,unread]=await Promise.all([Notification.find(filter).sort({createdAt:-1}).skip((page-1)*30).limit(31).lean(),Notification.countDocuments({...filter,readAt:null})]);
      res.json({notifications:notifications.slice(0,30),hasMore:notifications.length>30,unread});
    }));
    app.patch(`/api/${role}/notifications/read`,guard,wrap(async(req,res)=>{
      await Notification.updateMany({ownerRole:role,ownerId:owner(req,role),readAt:null},{$set:{readAt:new Date()}});res.json({read:true});
    }));
    app.get(`/api/${role}/support`,guard,wrap(async(req,res)=>{
      const filter=role==='admin'?{}:{ownerRole:role,ownerId:owner(req,role)};
      const page=Math.max(1,Number.parseInt(req.query.page,10)||1);
      const tickets=await Ticket.find(filter).sort({updatedAt:-1}).skip((page-1)*20).limit(21).lean();
      res.json({tickets:tickets.slice(0,20),hasMore:tickets.length>20});
    }));
    app.get(`/api/${role}/support/:id/photo`,guard,wrap(async(req,res)=>{
      if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid ticket.'});
      const ticket=await Ticket.findOne({_id:req.params.id,...(role==='admin'?{}:{ownerRole:role,ownerId:owner(req,role)})}).select('+photoEncrypted');
      if(!ticket)return res.status(404).json({message:'Ticket not found.'});
      res.json({photo:decryptPrivate(ticket.photoEncrypted,`ticket:${ticket.ownerRole}:${ticket.ownerId}`)});
    }));
    app.post(`/api/${role}/support/:id/reply`,guard,wrap(async(req,res)=>{
      const text=String(req.body?.message||'').trim();
      if(!mongoose.isValidObjectId(req.params.id)||!text||text.length>2000)return res.status(400).json({message:'Enter a reply up to 2,000 characters.'});
      const ticket=await Ticket.findOneAndUpdate({_id:req.params.id,'messages.99':{$exists:false},...(role==='admin'?{}:{ownerRole:role,ownerId:owner(req,role)})},
        {$push:{messages:{role,text,createdAt:new Date()}},$set:{status:role==='admin'&&req.body?.resolved===true?'resolved':'open'}},{new:true});
      if(!ticket)return res.status(409).json({message:'Ticket not found or conversation limit reached.'});
      if(role==='admin')await quietNotify(ticket.ownerRole,[ticket.ownerId],'HomeFix replied','Open Support to read the response.','support',ticket.bookingId);
      else await quietNotify('admin',['admin'],'New support reply','Open Support to read the customer or worker reply.','support',ticket.bookingId);
      res.json({ticket});
    }));
    if(role!=='admin')app.post(`/api/${role}/support`,guard,wrap(async(req,res)=>{
      const subject=String(req.body?.subject||'').trim(),message=String(req.body?.message||'').trim(),photo=req.body?.photo;
      if(subject.length<3||subject.length>100||message.length<5||message.length>2000||(photo&&!validateImage(photo,400000)))return res.status(400).json({message:'Enter a subject, a message of 5–2,000 characters and an optional JPEG/PNG image.'});
      const ownerId=owner(req,role),filter={ownerRole:role,ownerId};
      if(await Ticket.countDocuments({...filter,createdAt:{$gt:new Date(Date.now()-86400000)}})>=20)return res.status(429).json({message:'Daily support ticket limit reached.'});
      let bookingId=null;
      if(req.body?.bookingId){
        if(!mongoose.isValidObjectId(req.body.bookingId))return res.status(400).json({message:'Invalid order.'});
        const booking=await Booking.exists({_id:req.body.bookingId,...(role==='customer'?{customerUid:req.customer.uid}:{assignedWorkerId:req.worker._id})});
        if(!booking)return res.status(404).json({message:'Order not found.'});bookingId=req.body.bookingId;
      }
      const ticket=await Ticket.create({...filter,bookingId,subject,messages:[{role,text:message,createdAt:new Date()}],
        ...(photo?{photoEncrypted:encryptPrivate(photo,`ticket:${role}:${ownerId}`)}:{})});
      await quietNotify('admin',['admin'],'New support issue','A customer or worker has requested help.','support',bookingId);
      res.status(201).json({ticket:{_id:ticket._id,subject:ticket.subject,status:ticket.status,messages:ticket.messages,createdAt:ticket.createdAt}});
    }));
  }
  app.post('/api/worker/firebase-login',wrap(async(req,res)=>{
    if(!customerFirebaseAuth||!process.env.ADMIN_SESSION_SECRET)return res.status(503).json({message:'Verified worker sign-in is not configured.'});
    if(!limit(req.ip||'unknown'))return res.status(429).json({message:'Too many sign-in attempts. Try later.'});
    const token=(req.get('authorization')||'').match(/^Bearer\s+(.+)$/i)?.[1];
    let decoded;
    try{decoded=await customerFirebaseAuth.verifyIdToken(token||'');}catch(_){return res.status(401).json({message:'Verify your mobile number to sign in.'});}
    const phone=customerLocalPhone(decoded.phone_number);
    if(!phone)return res.status(403).json({message:'Verify an Indian mobile number with SMS first.'});
    const existing=await Worker.findOne({phone});
    if(existing&&(!existing.active||(existing.firebaseUid&&existing.firebaseUid!==decoded.uid)))return res.status(403).json({message:'This account is disabled or linked to a different identity. Contact Admin.'});
    if(req.body?.resume===true&&(!existing||existing.firebaseUid!==decoded.uid||existing.termsVersion!==POLICY_VERSION))return res.status(409).json({message:'Sign in and accept the current terms before restoring this worker account.'});
    let worker=existing;
    if(!worker){
      if(req.body?.termsVersion!==POLICY_VERSION)return res.status(400).json({message:'Accept the current Terms and Privacy Policy.'});
      const salt=crypto.randomBytes(16).toString('hex');
      try{worker=await Worker.create({name:String(decoded.name||req.body?.name||'HomeFix worker').slice(0,100),phone,
        firebaseUid:decoded.uid,phoneVerified:true,salt,passwordHash:await hashPassword(crypto.randomBytes(32).toString('hex'),salt),
        termsAcceptedAt:new Date(),termsVersion:POLICY_VERSION});}
      catch(error){if(error.code===11000)return res.status(409).json({message:'Account changed. Please sign in again.'});throw error;}
    }else worker=await Worker.findOneAndUpdate({_id:worker._id,active:true,$or:[{firebaseUid:decoded.uid},{firebaseUid:null},{firebaseUid:{$exists:false}}]},
      {$set:{firebaseUid:decoded.uid,phoneVerified:true,...(req.body?.termsVersion===POLICY_VERSION?{termsAcceptedAt:new Date(),termsVersion:POLICY_VERSION}:{})}},{new:true});
    if(!worker)return res.status(409).json({message:'Account changed. Sign in again.'});
    res.json({token:signWorkerToken(worker,process.env.ADMIN_SESSION_SECRET),worker:publicWorker(worker)});
  }));
  app.patch('/api/worker/skills',requireWorker,wrap(async(req,res)=>{
    const skills=req.body?.skills;
    if(!Array.isArray(skills)||!skills.length||skills.length>6||skills.some(v=>!SERVICES.includes(v)))return res.status(400).json({message:'Choose at least one supported service skill.'});
    const worker=await Worker.findByIdAndUpdate(req.worker._id,{$set:{skills:[...new Set(skills)]}},{new:true});
    await quietNotify('admin',['admin'],'Worker skills need review','Open Manage workers to review requested service skills.','worker_skills');res.json({worker:publicWorker(worker)});
  }));
  app.patch('/api/admin/workers/:id/skills',requireAdminKey,wrap(async(req,res)=>{
    if(!mongoose.isValidObjectId(req.params.id)||!Array.isArray(req.body?.skills)||req.body.skills.some(v=>!SERVICES.includes(v)))return res.status(400).json({message:'Choose valid skills.'});
    const worker=await Worker.findByIdAndUpdate(req.params.id,{$set:{approvedSkills:[...new Set(req.body.skills)]}},{new:true});
    if(!worker)return res.status(404).json({message:'Worker not found.'});res.json({worker:publicWorker(worker)});
  }));
  app.patch('/api/worker/availability',requireWorker,wrap(async(req,res)=>{
    if(typeof req.body?.online!=='boolean')return res.status(400).json({message:'Choose online or offline.'});
    if(req.body.online&&(!req.worker.phoneVerified||req.worker.verificationStatus!=='approved'||!req.worker.payoutSummary||!req.worker.approvedSkills?.length))return res.status(403).json({message:'Verify your mobile, identity, payout details and approved skills before going online.'});
    const worker=await Worker.findByIdAndUpdate(req.worker._id,{$set:{online:req.body.online,availableUntil:req.body.online?new Date(Date.now()+8*3600000):null,lastSeenAt:new Date()}},{new:true});
    res.json({worker:publicWorker(worker)});
  }));
  app.get('/api/worker/offers',requireWorker,wrap(async(req,res)=>{
    if(!req.worker.active||!req.worker.phoneVerified||req.worker.verificationStatus!=='approved'||!req.worker.payoutSummary||!req.worker.online||new Date(req.worker.availableUntil)<=new Date())return res.json({offers:[],online:false,worker:publicWorker(req.worker)});
    const page=Math.max(1,Number.parseInt(req.query.page,10)||1);
    const bookings=await Booking.find({status:'pending',assignedWorkerId:null,service:{$in:req.worker.approvedSkills||[]},
      $or:[{scheduledAt:{$gt:new Date()}},{scheduledAt:null}]}).sort({createdAt:-1}).skip((page-1)*30).limit(31).lean();
    res.json({offers:bookings.slice(0,30).map(safeOffer),hasMore:bookings.length>30,online:true,worker:publicWorker(req.worker)});
  }));
  app.post('/api/worker/bookings/:id/claim',requireWorker,wrap(async(req,res)=>{
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid order.'});
    const booking=await Booking.findById(req.params.id);
    if(!booking||!eligible(req.worker,booking.service))return res.status(403).json({message:'This order does not match your approved skills or online availability.'});
    const claimed=await Booking.findOneAndUpdate({_id:booking._id,status:'pending',assignedWorkerId:null,dispatchMode:'first_claim',
      service:{$in:req.worker.approvedSkills},$or:[{scheduledAt:{$gt:new Date()}},{scheduledAt:null}]},
      {$set:{assignedWorkerId:req.worker._id,assignedWorkerName:req.worker.name,assignedAt:new Date(),status:'accepted'}},{new:true});
    if(!claimed)return res.status(409).json({message:'Another worker accepted this order, or Admin is assigning it. Refresh offers.'});
    await Promise.all([quietNotify('admin',['admin'],'Worker accepted an order',`${claimed.service} has been accepted.`,'claimed',claimed._id),
      quietNotify('customer',[claimed.customerUid],'Your worker is assigned',`Open your ${claimed.service} order for details.`,'assignment',claimed._id)]);
    res.json({bookingId:String(claimed._id),assigned:true});
  }));
  app.patch('/api/admin/bookings/:id/dispatch',requireAdminKey,wrap(async(req,res)=>{
    if(!mongoose.isValidObjectId(req.params.id)||!['first_claim','admin_assign'].includes(req.body?.mode))return res.status(400).json({message:'Choose first accept or Admin assignment.'});
    const booking=await Booking.findOneAndUpdate({_id:req.params.id,status:'pending',assignedWorkerId:null},{$set:{dispatchMode:req.body.mode}},{new:true});
    if(!booking)return res.status(409).json({message:'Only an unassigned pending order can change matching mode.'});
    await notifyBooking(booking);res.json({dispatchMode:booking.dispatchMode});
  }));
  for (const [role, guard] of [['customer', requireCustomer], ['worker', requireWorker], ['admin', requireAdminKey]]) {
    app.get(`/api/${role}/bookings/:id`, guard, wrap(async (req, res) => {
      if (role === 'worker' && (!req.worker.phoneVerified || req.worker.verificationStatus !== 'approved' || !req.worker.payoutSummary)) return res.status(403).json({ message: 'Identity approval and payout setup are required to view service details.' });
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid order.' });
      const booking = await Booking.findOne({ _id: req.params.id, ...(role === 'customer' ? { customerUid: req.customer.uid } : role === 'worker' ? { assignedWorkerId: req.worker._id } : {}) }).lean();
      if (!booking) return res.status(404).json({ message: 'Order not found.' });
      const fields = ['service','date','time','scheduledAt','status','createdAt','completedAt','address','location','problem','customerName','phone','alternatePhone','assignedWorkerName',
        'quotedAmountPaise','paymentMethod','paymentStatus','paymentUpdatedAt','paidAt','cashCollection','completionRequestedAt','completionVerifiedAt','workStartedAt','quoteAcceptedAt','review','dispatchMode'];
      const result = { bookingId: String(booking._id) };
      for (const field of fields) result[field] = booking[field] ?? null;
      if (role !== 'worker') { result.paymentReference = booking.razorpayPaymentId || null; result.paymentHistory = booking.paymentHistory || []; }
      if (role === 'admin') { result.workerSettlement = booking.workerSettlement || null; result.assignedWorkerId = booking.assignedWorkerId || null; }
      res.json({ booking: result });
    }));
  }
  app.post('/api/worker/bookings/:id/start',requireWorker,wrap(async(req,res)=>{
    if(!req.worker.phoneVerified||req.worker.verificationStatus!=='approved'||!req.worker.payoutSummary)return res.status(403).json({message:'Verify your mobile, identity and payout details first.'});
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid order.'});
    const booking=await Booking.findOneAndUpdate({_id:req.params.id,assignedWorkerId:req.worker._id,status:'accepted',workStartedAt:null,quoteAcceptedAt:{$ne:null}},{$set:{workStartedAt:new Date()}},{new:true});
    if(!booking)return res.status(409).json({message:'Customer must accept the service quote before work starts.'});
    await quietNotify('customer',[booking.customerUid],'Your service has started','Open your order for progress and payment details.','started',booking._id);res.json({started:true});
  }));
  app.post('/api/customer/bookings/:id/quote-accept',requireCustomer,wrap(async(req,res)=>{
    if(!mongoose.isValidObjectId(req.params.id)||!Number.isSafeInteger(req.body?.amountPaise))return res.status(400).json({message:'Invalid order or quote.'});
    const booking=await Booking.findOneAndUpdate({_id:req.params.id,customerUid:req.customer.uid,status:{$nin:['completed','cancelled']},quotedAmountPaise:req.body.amountPaise},
      {$set:{quoteAcceptedAt:new Date(),acceptedQuotePaise:req.body.amountPaise}},{new:true});
    if(!booking)return res.status(409).json({message:'Quote changed. Refresh your order before accepting.'});res.json({accepted:true});
  }));
  app.post('/api/worker/bookings/:id/evidence',requireWorker,wrap(async(req,res)=>{
    if(!req.worker.phoneVerified||req.worker.verificationStatus!=='approved'||!req.worker.payoutSummary)return res.status(403).json({message:'Verify your mobile, identity and payout details first.'});
    if(!mongoose.isValidObjectId(req.params.id)||!imagesValid(req.body?.images))return res.status(400).json({message:'Choose 1–3 JPEG/PNG result photos, each below 400 KB.'});
    const id=req.params.id;
    const booking=await Booking.findOneAndUpdate({_id:id,assignedWorkerId:req.worker._id,status:'accepted',workStartedAt:{$ne:null}},
      {$set:{completionPhotosEncrypted:encryptPrivate(req.body.images,`booking:${id}:result`),completionPhotoWorkerId:req.worker._id,completionRequestedAt:new Date()},
       $unset:{completionOtpHash:1,completionOtpExpiresAt:1}},{new:true});
    if(!booking)return res.status(409).json({message:'Start this assigned job after the customer accepts its quote.'});
    await quietNotify('customer',[booking.customerUid],'Your worker uploaded the result','Review the result photos, then show your completion code only if the work is finished.','completion_requested',booking._id);
    res.json({message:'Result uploaded. Ask the customer to open the order and generate their completion code.'});
  }));
  for(const [role,guard] of [['customer',requireCustomer],['worker',requireWorker],['admin',requireAdminKey]])app.get(`/api/${role}/bookings/:id/photos`,guard,wrap(async(req,res)=>{
    if(role==='worker'&&(!req.worker.phoneVerified||req.worker.verificationStatus!=='approved'||!req.worker.payoutSummary))return res.status(403).json({message:'Identity approval and payout setup are required to view service photos.'});
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid order.'});
    const booking=await Booking.findOne({_id:req.params.id,...(role==='customer'?{customerUid:req.customer.uid}:role==='worker'?{assignedWorkerId:req.worker._id}:{})})
      .select('+problemPhotosEncrypted +completionPhotosEncrypted');
    if(!booking)return res.status(404).json({message:'Order not found.'});
    res.json({problem:decryptPrivate(booking.problemPhotosEncrypted,`booking:${booking._id}:problem`)||[],
      result:decryptPrivate(booking.completionPhotosEncrypted,`booking:${booking._id}:result`)||[]});
  }));
  app.post('/api/customer/bookings/:id/completion-code',requireCustomer,wrap(async(req,res)=>{
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid order.'});
    const now=new Date(),code=String(crypto.randomInt(100000,1000000)),id=req.params.id;
    const booking=await Booking.findOneAndUpdate({_id:id,customerUid:req.customer.uid,status:'accepted',assignedWorkerId:{$ne:null},completionRequestedAt:{$ne:null},
      $or:[{completionOtpIssuedAt:{$lt:new Date(Date.now()-60000)}},{completionOtpIssuedAt:null}],
      $and:[{$or:[{completionOtpWindowAt:{$lt:new Date(Date.now()-3600000)}},{completionOtpWindowAt:null},{completionOtpIssueCount:{$lt:5}}]}]},
      {$set:{completionOtpHash:completionHash(id,code),completionOtpExpiresAt:new Date(Date.now()+10*60000),completionOtpIssuedAt:now,completionOtpAttempts:0},$inc:{completionOtpIssueCount:1}},{new:true});
    if(!booking)return res.status(409).json({message:'Review the worker’s result first. A code can be renewed once per minute, up to five times per hour.'});
    // The quota window is anchored independently from the expiring OTP.
    if(!booking.completionOtpWindowAt||booking.completionOtpWindowAt<new Date(Date.now()-3600000))await Booking.updateOne({_id:id,completionOtpIssuedAt:now},{$set:{completionOtpWindowAt:now,completionOtpIssueCount:1}});
    res.json({code,expiresAt:booking.completionOtpExpiresAt,message:'Show this to your assigned worker only after checking the finished service. It confirms completion, not payment.'});
  }));
  app.post('/api/worker/bookings/:id/complete',requireWorker,wrap(async(req,res)=>{
    if(!req.worker.phoneVerified||req.worker.verificationStatus!=='approved'||!req.worker.payoutSummary)return res.status(403).json({message:'Verify your mobile, identity and payout details first.'});
    const id=req.params.id,code=String(req.body?.code||'');
    if(!mongoose.isValidObjectId(id)||!/^\d{6}$/.test(code))return res.status(400).json({message:'Enter the six-digit code from the customer’s app.'});
    const booking=await Booking.findOne({_id:id,assignedWorkerId:req.worker._id,status:'accepted'}).select('+completionOtpHash');
    if(!booking||!booking.completionOtpHash||!booking.completionRequestedAt||String(booking.completionPhotoWorkerId)!==String(req.worker._id))return res.status(409).json({message:'Upload the result photos and ask the customer for a fresh completion code.'});
    if(booking.completionOtpExpiresAt<=new Date())return res.status(410).json({message:'Completion code expired. Ask the customer to generate a new one.'});
    if(booking.completionOtpAttempts>=5)return res.status(429).json({message:'Too many incorrect codes. The customer must generate a new code.'});
    const expected=Buffer.from(booking.completionOtpHash,'hex'),actual=Buffer.from(completionHash(id,code),'hex');
    if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual)){
      await Booking.updateOne({_id:id,assignedWorkerId:req.worker._id,completionOtpHash:booking.completionOtpHash,completionOtpAttempts:{$lt:5}},{$inc:{completionOtpAttempts:1}});
      return res.status(400).json({message:'Incorrect completion code.'});
    }
    const done=await Booking.findOneAndUpdate({_id:id,assignedWorkerId:req.worker._id,status:'accepted',completionOtpHash:booking.completionOtpHash,
      completionOtpExpiresAt:{$gt:new Date()},completionOtpAttempts:{$lt:5},completionPhotoWorkerId:req.worker._id},
      {$set:{status:'completed',completedAt:new Date(),completionVerifiedAt:new Date()},$unset:{completionOtpHash:1,completionOtpExpiresAt:1}},{new:true});
    if(!done)return res.status(409).json({message:'Code was already used or the order changed. Refresh your jobs.'});
    await Promise.all([quietNotify('customer',[done.customerUid],'Service completion confirmed','Thank you. Review your service and check the payment receipt in your order.','completed',done._id),
      quietNotify('admin',['admin'],'Customer verified service completion',`${done.service} is complete.`,'completed',done._id)]);
    res.json({completed:true,completedAt:done.completedAt});
  }));
  app.post('/api/customer/bookings/:id/review',requireCustomer,wrap(async(req,res)=>{
    const stars=req.body?.stars,comment=String(req.body?.comment||'').trim();
    if(!mongoose.isValidObjectId(req.params.id)||!Number.isInteger(stars)||stars<1||stars>5||comment.length>1500)return res.status(400).json({message:'Choose 1–5 stars and a comment up to 1,500 characters.'});
    const booking=await Booking.findOne({_id:req.params.id,customerUid:req.customer.uid,status:'completed',completionVerifiedAt:{$ne:null}});
    if(!booking)return res.status(409).json({message:'Only your customer-verified completed service can be reviewed.'});
    try{
      await Review.init();
      const session=await mongoose.startSession();
      let review;
      try { await session.withTransaction(async()=>{
        const claimed=await Booking.findOneAndUpdate({_id:booking._id,customerUid:req.customer.uid,status:'completed',review:null},
          {$set:{review:{stars,comment,public:req.body?.public===true,createdAt:new Date()}}},{new:true,session});
        if(!claimed){const error=new Error('already reviewed');error.code=11000;throw error;}
        [review]=await Review.create([{bookingId:booking._id,customerUid:req.customer.uid,service:booking.service,stars,comment,public:req.body?.public===true}],{session});
      }); } finally { await session.endSession(); }
      await quietNotify('admin',['admin'],'New service feedback',`A customer rated ${booking.service} ${stars}/5.`,'review',booking._id);
      res.status(201).json({review:{stars,comment,public:review.public,createdAt:review.createdAt}});
    }catch(error){if(error.code===11000)return res.status(409).json({message:'This order already has a review.'});throw error;}
  }));
  app.get('/api/services/reviews',wrap(async(req,res)=>{
    const service=String(req.query.service||'');if(!SERVICES.includes(service))return res.status(400).json({message:'Choose a supported service.'});
    const [reviews,totals]=await Promise.all([Review.find({service,public:true}).select('stars comment createdAt -_id').sort({createdAt:-1}).limit(30).lean(),
      Review.aggregate([{$match:{service,public:true}},{$group:{_id:null,count:{$sum:1},average:{$avg:'$stars'}}}])]);
    res.json({reviews,count:totals[0]?.count||0,average:totals[0]?.average||0});
  }));
  app.get('/api/admin/reviews',requireAdminKey,wrap(async(req,res)=>{
    const page=Math.max(1,Number.parseInt(req.query.page,10)||1),reviews=await Review.find().sort({createdAt:-1}).skip((page-1)*30).limit(31).lean();
    res.json({reviews:reviews.slice(0,30),hasMore:reviews.length>30});
  }));
  app.get('/api/policies',wrap(async(_req,res)=>res.json({version:POLICY_VERSION,terms:TERMS,privacy:PRIVACY})));
  app.get('/terms',(_req,res)=>res.type('html').send(policyHtml('HomeFix service terms',TERMS)));
  app.get('/privacy',(_req,res)=>res.type('html').send(policyHtml('HomeFix privacy policy',PRIVACY)));
  app.locals.servicePolicyVersion=POLICY_VERSION;
}
const TERMS = `HomeFix connects customers with approved service workers. Select the correct service, a complete address or shared map pin, and your preferred date and time. Availability depends on worker acceptance or Admin assignment; a request is not a guaranteed arrival time.\n\nThe Admin quote and amount due are shown in your order. Accept the quote before work starts. Do not pay an undisclosed extra charge without contacting support. Online payments are confirmed only when verified by the payment provider; cash payments are shown separately.\n\nCheck the result photos and the finished work before sharing the one-time completion code. Sharing it confirms service completion, not cash payment or a waiver of your ability to raise an issue. Confirm cash only after actually paying it.\n\nWorkers must use their own verified mobile, submit identity and payout details, and work only in approved service categories. Going online makes matching order notifications available for an eight-hour shift; it does not guarantee work. Admin can assign or reassign orders. HomeFix commission normally starts at 20%, with the actual finalized commission shown per job. Withdrawals are reviewed and paid manually by Admin.\n\nContact support before cancelling an accepted visit or to request correction, cancellation or a refund. Admin reviews the particular order and payment; no automatic refund deadline or fee is promised by this app. Be accurate and respectful in photos, reviews and support messages. Do not upload someone else’s private information without permission.\n\nUse Call support, SMS support or the private support panel to reach HomeFix. These operational terms should be reviewed by the business owner before a wider public launch.`;
const PRIVACY = `HomeFix uses verified mobile numbers, optional linked Google account details, profile information, service addresses, optional alternate numbers, booking schedules, order and payment records, and service reviews to operate bookings and support.\n\nLocation is requested only when you tap Use my current location. The selected coordinates and accuracy are saved with that order for service navigation. HomeFix does not collect continuous background customer location in this release. You can enter an address without sharing GPS.\n\nProblem photos and result photos are private to the customer, assigned worker and Admin. Identity documents and full payout details are encrypted and available only for the appropriate account or Admin review. Do not submit passwords, bank PINs or OTPs in support messages or documents.\n\nDevice notification registrations are used to send order and support alerts. Notification previews contain limited order information; open the signed-in app for private details. Matching workers see service and schedule information before claiming, with contact/address details available after assignment. Workers receive offers only for approved skills while online.\n\nPhone verification and optional Google sign-in use Firebase/Google. Notifications use Firebase Cloud Messaging. Choosing navigation opens Google Maps. Online payments use the configured Razorpay service. Opening SMS or a phone call hands control to your device’s messaging or phone app; a message is not sent automatically by HomeFix.\n\nReviews are shared publicly only if you choose the publish option, without your name, phone or address. Private feedback and support tickets are visible to you and Admin. Order records and private documents are kept in the business database; contact support for access, correction or deletion requests and any records that must be retained for payment or dispute handling. Admin can remove reviewed ID images while keeping the review decision.\n\nContact HomeFix through the in-app support panel. This policy describes the implemented app behavior and is not a claim of regulatory certification.`;
function policyHtml(title,text){return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font:16px/1.7 system-ui;max-width:760px;margin:40px auto;padding:20px;color:#153e3a"><h1>${title}</h1>${text.split('\n\n').map(p=>`<p>${p}</p>`).join('')}<p>Version ${POLICY_VERSION}</p></body></html>`;}
module.exports={registerServiceOperations,SERVICES,POLICY_VERSION,validPin,eligible,completionHash,safeOffer,imagesValid};
