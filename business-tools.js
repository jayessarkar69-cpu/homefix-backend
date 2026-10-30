'use strict';
const crypto = require('crypto');

function dataKey() {
  if (process.env.PRIVATE_DATA_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.PRIVATE_DATA_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) throw new Error('Private data key not configured');
    return key;
  }
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('Private data key not configured');
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'homefix-private-storage', 'identity-and-payout-v1', 32));
}
function encryptPrivate(value, context = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}
function decryptPrivate(envelope, context = '') {
  if (!envelope) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString());
}
function validateImage(value, maxBytes = 800000) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) + 100) return false;
  const match = value.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length < 8 || bytes.length > maxBytes) return false;
  return match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
}
function settlementAmounts(gross, mode, value) {
  if (!Number.isSafeInteger(gross) || gross < 1) throw new Error('Invalid quote');
  let commission;
  if (mode === 'percent' && Number.isFinite(value) && value >= 0 && value <= 100) commission = Math.round(gross * value / 100);
  else if (mode === 'fixed' && Number.isSafeInteger(value) && value >= 0 && value <= gross) commission = value;
  else throw new Error('Invalid commission');
  return { grossPaise: gross, commissionPaise: commission, earningsPaise: gross - commission };
}
const walletFields = { earnedPaise: 0, cashHeldPaise: 0, balancePaise: 0, reservedPaise: 0, withdrawnPaise: 0, settledJobs: 0, grossPaise: 0, commissionPaise: 0, remittedPaise: 0 };
function walletView(worker) {
  const wallet = { ...walletFields, ...(worker.wallet?.toObject?.() || worker.wallet || {}) };
  return { ...wallet, availablePaise: Math.max(0, wallet.balancePaise - wallet.reservedPaise), owesHomeFixPaise: Math.max(0, -wallet.balancePaise) };
}
function registerBusinessTools({ app, mongoose, Booking, Worker, Customer, requireAdminKey, requireCustomer,
  requireWorker, wrap, hashPassword, publicWorker, limit }) {
  const Settings = mongoose.models.BusinessSettings || mongoose.model('BusinessSettings', new mongoose.Schema({
    _id: { type: String, default: 'main' }, supportPhone: { type: String, default: '9863902010' },
    commissionPercent: { type: Number, default: 20, min: 0, max: 100 },
  }));
  const Withdrawal = mongoose.models.WorkerWithdrawal || mongoose.model('WorkerWithdrawal', new mongoose.Schema({
    workerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true }, workerName: String,
    amountPaise: { type: Number, required: true, min: 1 }, status: { type: String, enum: ['requested','paid','rejected'], default: 'requested' },
    payoutSnapshot: { type: mongoose.Schema.Types.Mixed, select: false }, payoutSummary: String,
    reference: String, note: String, processedAt: Date,
  }, { timestamps: true }));
  const Settlement = mongoose.models.WorkerSettlement || mongoose.model('WorkerSettlement', new mongoose.Schema({
    bookingId: { type: mongoose.Schema.Types.ObjectId, unique: true, required: true }, workerId: { type: mongoose.Schema.Types.ObjectId, index: true },
    service: String, grossPaise: Number, commissionPaise: Number, earningsPaise: Number, cashHeldPaise: Number,
  }, { timestamps: true }));
  const Receipt = mongoose.models.WorkerRemittance || mongoose.model('WorkerRemittance', new mongoose.Schema({
    workerId: mongoose.Schema.Types.ObjectId, amountPaise: Number, reference: { type: String, unique: true },
  }, { timestamps: true }));
  async function transaction(action) {
    await Promise.all([Settlement.init(), Withdrawal.init(), Receipt.init()]);
    const session = await mongoose.startSession();
    try { let result; await session.withTransaction(async () => { result = await action(session); }); return result; }
    finally { await session.endSession(); }
  }
  function fail(code, message) { const error = new Error(message); error.status = code; throw error; }
  const moneyWrap = fn => wrap(async (req, res) => {
    try { await fn(req, res); } catch (error) {
      if (error.status) return res.status(error.status).json({ message: error.message });
      if (error.code === 11000) return res.status(409).json({ message: 'This job or receipt was already recorded.' });
      throw error;
    }
  });
  app.get('/api/config', wrap(async (_req, res) => {
    const settings = await Settings.findById('main').lean();
    let privateStorageReady = false;
    try { dataKey(); privateStorageReady = true; } catch (_) {}
    res.json({ privateStorageReady, supportPhone: settings?.supportPhone || '9863902010', commissionPercent: settings?.commissionPercent ?? 20,
      featureVersion: 5, smsReady: app.locals.smsReady?.() || false, completionCodes: 'customer_app', dispatchModes: ['first_claim','admin_assign'], policyVersion: '2026-10-30-v5', identityReview: 'manual', withdrawals: 'manual_admin_payment' });
  }));
  app.patch('/api/admin/settings', requireAdminKey, wrap(async (req, res) => {
    const phone = req.body?.supportPhone;
    const percent = req.body?.commissionPercent;
    if (!/^\d{10}$/.test(phone || '') || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      return res.status(400).json({ message: 'Enter a 10-digit phone and commission from 0 to 100.' });
    }
    const settings = await Settings.findByIdAndUpdate('main', { supportPhone: phone, commissionPercent: percent }, { upsert: true, new: true, runValidators: true });
    res.json({ settings });
  }));
  app.post('/api/worker/register',wrap(async(_req,res)=>res.status(426).json({message:'Update HomeFix Team and use verified mobile sign-in to join.'})));
  app.get('/api/worker/me', requireWorker, wrap(async (req, res) => {
    const pending=await Booking.find({assignedWorkerId:req.worker._id,status:'completed',paymentStatus:'paid',completionVerifiedAt:{$ne:null},workerPriceAcceptedAt:{$ne:null},'workerSettlement.settledAt':null}).select('_id').limit(20).lean();
    for(const job of pending)await app.locals.autoSettle(job._id).catch(()=>{});
    const freshWorker=await Worker.findById(req.worker._id).lean();
    const [settlements, withdrawals, totalJobs, completedJobs] = await Promise.all([
      Settlement.find({ workerId: req.worker._id }).sort({ createdAt: -1 }).limit(50).lean(),
      Withdrawal.find({ workerId: req.worker._id }).sort({ createdAt: -1 }).limit(50).lean(),
      Booking.countDocuments({ assignedWorkerId: req.worker._id }),
      Booking.countDocuments({ assignedWorkerId: req.worker._id, status: 'completed' }),
    ]);
    res.json({ worker: publicWorker(req.worker), wallet: walletView(freshWorker||req.worker), settlements, withdrawals,
      work: { totalJobs, completedJobs } });
  }));
  app.post('/api/worker/identity', requireWorker, wrap(async (req, res) => {
    try { dataKey(); } catch (_) { return res.status(503).json({ message: 'Private document storage needs server configuration. Contact Admin.' }); }
    const { documentType, documentLast4, legalName, documentImage, consent } = req.body || {};
    if (!['Voter ID','Driving licence','Passport','Masked Aadhaar'].includes(documentType) ||
        typeof legalName !== 'string' || !legalName.trim() || legalName.length > 100 ||
        !/^[a-zA-Z0-9]{4}$/.test(documentLast4 || '') || !validateImage(documentImage) || consent !== true) {
      return res.status(400).json({ message: 'Provide a supported ID, last four characters, legal name, photo and review consent. Mask unrelated ID numbers.' });
    }
    const encrypted = encryptPrivate({ legalName: legalName.trim(), documentType, documentLast4, documentImage }, `worker:${req.worker._id}:identity`);
    const worker = await Worker.findOneAndUpdate({ _id: req.worker._id, verificationStatus: { $ne: 'approved' } },
      { $set: { identityEncrypted: encrypted, verificationStatus: 'pending', identityType: documentType,
        identityLast4: documentLast4, identitySubmittedAt: new Date(), identitySubmissionId: crypto.randomUUID(), privateViewedSubmissionId: null, reviewNote: '', identityReviewedAt: null } }, { new: true });
    if (!worker) return res.status(409).json({ message: 'Your approved ID cannot be changed here. Contact Admin.' });
    res.json({ worker: publicWorker(worker) });
  }));
  app.patch('/api/worker/payout', requireWorker, wrap(async (req, res) => {
    try { dataKey(); } catch (_) { return res.status(503).json({ message: 'Private payout storage needs server configuration. Contact Admin.' }); }
    const { method, holderName, upi, accountNumber, ifsc } = req.body || {};
    if (typeof holderName !== 'string' || !holderName.trim() || holderName.length > 100 ||
        (method !== 'upi' && method !== 'bank') ||
        (method === 'upi' && !/^[a-zA-Z0-9._-]{2,100}@[a-zA-Z0-9.-]{2,50}$/.test(upi || '')) ||
        (method === 'bank' && (!/^\d{9,18}$/.test(accountNumber || '') || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc || '')))) {
      return res.status(400).json({ message: 'Enter the account holder and valid UPI, or bank account number and IFSC.' });
    }
    const payout = { method, holderName: holderName.trim(), ...(method === 'upi' ? { upi } : { accountNumber, ifsc }) };
    const summary = method === 'upi' ? `UPI ••••${upi.slice(-4)}` : `Bank ••••${accountNumber.slice(-4)}`;
    const worker = await Worker.findByIdAndUpdate(req.worker._id, { $set: { payoutEncrypted: encryptPrivate(payout, `worker:${req.worker._id}:payout`),
      payoutSummary: summary, payoutUpdatedAt: new Date() } }, { new: true });
    res.json({ worker: publicWorker(worker) });
  }));
  app.get('/api/admin/workers/:id/private', requireAdminKey, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid worker.' });
    const worker = await Worker.findById(req.params.id).select('+identityEncrypted +payoutEncrypted +identitySubmissionId');
    if (!worker) return res.status(404).json({ message: 'Worker not found.' });
    const identity = decryptPrivate(worker.identityEncrypted, `worker:${worker._id}:identity`), payout = decryptPrivate(worker.payoutEncrypted, `worker:${worker._id}:payout`);
    await Worker.updateOne({ _id: worker._id, identitySubmissionId: worker.identitySubmissionId }, { $set: { privateViewedAt: new Date(), privateViewedSubmissionId: worker.identitySubmissionId } });
    res.json({ worker: publicWorker(worker), identity, payout, wallet: walletView(worker) });
  }));
  app.patch('/api/admin/workers/:id/review', requireAdminKey, wrap(async (req, res) => {
    const status = req.body?.status;
    const note = String(req.body?.note || '').trim();
    if (!mongoose.isValidObjectId(req.params.id) || !['approved','rejected'].includes(status) || note.length > 300) {
      return res.status(400).json({ message: 'Choose approved or rejected, with a note up to 300 characters.' });
    }
    const worker = await Worker.findOneAndUpdate({ _id: req.params.id, verificationStatus: 'pending', $expr: { $and: [{ $ne: ['$identitySubmissionId', null] }, { $eq: ['$privateViewedSubmissionId', '$identitySubmissionId'] }] } },
      { $set: { verificationStatus: status, reviewNote: note, identityReviewedAt: new Date() } }, { new: true });
    if (!worker) return res.status(409).json({ message: 'No pending identity submission. Refresh workers.' });
    res.json({ worker: publicWorker(worker) });
  }));
  app.delete('/api/admin/workers/:id/identity', requireAdminKey, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid worker.' });
    const worker = await Worker.findOneAndUpdate({ _id: req.params.id, verificationStatus: { $in: ['approved','rejected'] } },
      { $unset: { identityEncrypted: 1 } }, { new: true });
    if (!worker) return res.status(409).json({ message: 'Review the document before removing its stored image.' });
    res.json({ worker: publicWorker(worker) });
  }));
  async function settleBooking(id,mode,value,automatic=false) {
    return transaction(async session => {
      const booking = await Booking.findOne({ _id: id, status: 'completed', paymentStatus: 'paid',
        assignedWorkerId: { $ne: null }, 'workerSettlement.settledAt': null, ...(automatic?{completionVerifiedAt:{$ne:null},workerPriceAcceptedAt:{$ne:null}}:{}) }).session(session);
      if (!booking) fail(409, 'Job must be completed, paid, assigned and not already settled.');
      if(booking.workerPriceAcceptedAt&&(mode!==(booking.commissionMode||'percent')||value!==(booking.commissionValue??20)))fail(409,'The worker-approved commission cannot be changed after service completion.');
      let values;
      try { values = settlementAmounts(booking.quotedAmountPaise, mode, value); }
      catch (_) { fail(400, 'Enter a valid commission. Fixed amounts must be in paise.'); }
      const worker = await Worker.findById(booking.assignedWorkerId).session(session);
      if (!worker || worker.verificationStatus !== 'approved') fail(409, 'Verify the worker identity before settling earnings.');
      const held = booking.paymentMethod === 'cash_on_service' && booking.cashCollection?.status === 'customer_confirmed'
        && String(booking.cashCollection.workerId) === String(worker._id) ? values.grossPaise : 0;
      const [record] = await Settlement.create([{ bookingId: booking._id, workerId: worker._id, service: booking.service,
        ...values, cashHeldPaise: held }], { session });
      booking.workerSettlement = { ...values, cashHeldPaise: held, settledAt: new Date() };
      await booking.save({ session });
      await Worker.updateOne({ _id: worker._id }, { $inc: {
        'wallet.grossPaise': values.grossPaise, 'wallet.commissionPaise': values.commissionPaise,
        'wallet.earnedPaise': values.earningsPaise, 'wallet.cashHeldPaise': held,
        'wallet.balancePaise': values.earningsPaise - held, 'wallet.settledJobs': 1,
      } }, { session });
      return record;
    });
  }
  app.locals = app.locals || {};
  app.locals.autoSettle = async id => {
    const booking = await Booking.findOne({_id:id,status:'completed',paymentStatus:'paid',completionVerifiedAt:{$ne:null},workerPriceAcceptedAt:{$ne:null},'workerSettlement.settledAt':null});
    if(!booking)return null;
    try { return await settleBooking(id,booking.commissionMode||'percent',booking.commissionValue??20,true); }
    catch(error) { if(error.code===11000||error.status===409)return null; throw error; }
  };
  app.post('/api/admin/bookings/:id/settlement', requireAdminKey, moneyWrap(async (req,res)=>{
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid booking.'});
    const result=await settleBooking(req.params.id,req.body?.mode,req.body?.value);
    res.json({settlement:result});
  }));
  app.patch('/api/admin/bookings/:id/commission',requireAdminKey,moneyWrap(async(req,res)=>{
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid booking.'});
    const booking=await Booking.findOne({_id:req.params.id,status:{$nin:['completed','cancelled']},workStartedAt:null});
    if(!booking)return res.status(409).json({message:'Commission is locked after work starts.'});
    try{settlementAmounts(booking.quotedAmountPaise,req.body?.mode,req.body?.value);}catch(_){return res.status(400).json({message:'Enter a valid commission.'});}
    const updated=await Booking.findOneAndUpdate({_id:booking._id,workStartedAt:null,status:{$nin:['completed','cancelled']}},{$set:{commissionMode:req.body.mode,commissionValue:req.body.value,workerPriceAcceptedAt:null,workerAcceptedPricePaise:null},$inc:{__v:1}},{new:true});
    if(!updated)return res.status(409).json({message:'Order changed.'});res.json({message:'Commission updated. Worker must approve the service price again.'});
  }));
  require('./workforce').registerWorkforce({app,mongoose,Worker,Booking,requireWorker,requireCustomer,requireAdminKey,wrap,publicWorker});
  require('./service-sms').registerServiceSms({app,mongoose,Customer,requireCustomer,requireAdminKey,wrap});
  app.post('/api/worker/withdrawals', requireWorker, moneyWrap(async (req, res) => {
    const amount = req.body?.amountPaise;
    if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(400).json({ message: 'Enter a positive withdrawal amount.' });
    const result = await transaction(async session => {
      const worker = await Worker.findById(req.worker._id).select('+payoutEncrypted').session(session);
      if (!worker || worker.verificationStatus !== 'approved' || !worker.payoutEncrypted) fail(409, 'Complete identity approval and payout details first.');
      if (amount > walletView(worker).availablePaise) fail(409, 'Withdrawal exceeds your available balance.');
      const reserved = await Worker.updateOne({ _id: worker._id,
        $expr: { $gte: [{ $subtract: [{ $ifNull: ['$wallet.balancePaise',0] }, { $ifNull: ['$wallet.reservedPaise',0] }] }, amount] } },
        { $inc: { 'wallet.reservedPaise': amount } }, { session });
      if (reserved.modifiedCount !== 1) fail(409, 'Your balance changed. Refresh and retry.');
      const [withdrawal] = await Withdrawal.create([{ workerId: worker._id, workerName: worker.name,
        amountPaise: amount, payoutSnapshot: worker.payoutEncrypted, payoutSummary: worker.payoutSummary }], { session });
      return withdrawal;
    });
    res.status(201).json({ message: 'Withdrawal requested. Admin will review and pay manually.', withdrawal: {
      _id: result._id, amountPaise: result.amountPaise, status: result.status, createdAt: result.createdAt,
    } });
  }));
  app.get('/api/admin/business', requireAdminKey, wrap(async (_req, res) => {
    const [workers, pending, unsettledJobs] = await Promise.all([
      Worker.aggregate([{ $group: { _id: null,
        grossPaise: { $sum: '$wallet.grossPaise' }, commissionPaise: { $sum: '$wallet.commissionPaise' },
        earnedPaise: { $sum: '$wallet.earnedPaise' }, withdrawnPaise: { $sum: '$wallet.withdrawnPaise' },
        owedPaise: { $sum: { $cond: [{ $lt: ['$wallet.balancePaise', 0] }, { $multiply: ['$wallet.balancePaise', -1] }, 0] } },
      } }]),
      Withdrawal.aggregate([{ $match: { status: 'requested' } }, { $group: { _id: null, amount: { $sum: '$amountPaise' } } }]),
      Booking.countDocuments({ status: 'completed', paymentStatus: 'paid', assignedWorkerId: { $ne: null }, 'workerSettlement.settledAt': null }),
    ]);
    res.json({ ...(workers[0] || {}), pendingWithdrawalPaise: pending[0]?.amount || 0, unsettledJobs });
  }));
  app.get('/api/admin/withdrawals', requireAdminKey, wrap(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const withdrawals = await Withdrawal.find().sort({ createdAt: -1 }).skip((page - 1) * 50).limit(51).lean();
    res.json({ withdrawals: withdrawals.slice(0,50), hasMore: withdrawals.length > 50 });
  }));
  app.get('/api/admin/withdrawals/:id/payout', requireAdminKey, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid request.' });
    const withdrawal = await Withdrawal.findById(req.params.id).select('+payoutSnapshot');
    if (!withdrawal) return res.status(404).json({ message: 'Withdrawal not found.' });
    res.json({ payout: decryptPrivate(withdrawal.payoutSnapshot, `worker:${withdrawal.workerId}:payout`) });
  }));
  app.patch('/api/admin/withdrawals/:id', requireAdminKey, moneyWrap(async (req, res) => {
    const status = req.body?.status, reference = String(req.body?.reference || '').trim(), note = String(req.body?.note || '').trim();
    if (!mongoose.isValidObjectId(req.params.id) || !['paid','rejected'].includes(status) ||
      reference.length > 120 || note.length > 300 || (status === 'paid' && !reference)) {
      return res.status(400).json({ message: 'For paid requests enter the real transfer reference. Otherwise choose rejected with a note.' });
    }
    const result = await transaction(async session => {
      const request = await Withdrawal.findOneAndUpdate({ _id: req.params.id, status: 'requested' },
        { $set: { status, reference: status === 'paid' ? reference : '', note, processedAt: new Date() } }, { new: true, session });
      if (!request) fail(409, 'This withdrawal was already processed.');
      const update = await Worker.updateOne({ _id: request.workerId, 'wallet.reservedPaise': { $gte: request.amountPaise } },
        { $inc: { 'wallet.reservedPaise': -request.amountPaise, ...(status === 'paid' ? {
          'wallet.balancePaise': -request.amountPaise, 'wallet.withdrawnPaise': request.amountPaise,
        } : {}) } }, { session });
      if (update.modifiedCount !== 1) fail(409, 'Reserved balance mismatch. No update was applied.');
      return request;
    });
    res.json({ withdrawal: result });
  }));
  app.post('/api/admin/workers/:id/cash-remittance', requireAdminKey, moneyWrap(async (req, res) => {
    const amount = req.body?.amountPaise, reference = String(req.body?.reference || '').trim();
    if (!mongoose.isValidObjectId(req.params.id) || !Number.isSafeInteger(amount) || amount <= 0 || !reference || reference.length > 120) {
      return res.status(400).json({ message: 'Enter the received remittance amount and receipt/reference.' });
    }
    // Unique receipt IDs make a repeated submit idempotent rather than a second credit.
    await transaction(async session => {
      const worker = await Worker.findById(req.params.id).session(session);
      if (!worker || amount > Math.max(0, -(worker.wallet?.balancePaise || 0))) fail(409, 'Amount exceeds what this worker owes HomeFix.');
      await Receipt.create([{ workerId: worker._id, amountPaise: amount, reference }], { session });
      await Worker.updateOne({ _id: worker._id }, { $inc: { 'wallet.balancePaise': amount, 'wallet.remittedPaise': amount } }, { session });
    });
    res.json({ message: 'Commission remittance recorded.' });
  }));
}
module.exports = { registerBusinessTools, encryptPrivate, decryptPrivate, validateImage, settlementAmounts, walletView };
