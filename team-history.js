'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

function signWorkerToken(worker, secret) {
  const payload = Buffer.from(JSON.stringify({ role: 'worker', sub: String(worker._id),
    version: worker.sessionVersion, exp: Math.floor(Date.now() / 1000) + 28800 })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
function verifyWorkerToken(token, secret) {
  if (!secret || typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
  const supplied = Buffer.from(parts[1]);
  const actual = Buffer.from(expected);
  if (supplied.length !== actual.length || !crypto.timingSafeEqual(supplied, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return payload.role === 'worker' && typeof payload.sub === 'string' &&
      Number.isInteger(payload.version) && Number.isFinite(payload.exp) &&
      payload.exp > Date.now() / 1000 ? payload : null;
  } catch (_) { return null; }
}
async function hashPassword(password, salt) {
  return (await scrypt(password, salt, 64)).toString('hex');
}
function publicWorker(worker) {
  return { id: String(worker._id), name: worker.name, phone: worker.phone, active: worker.active,
    verificationStatus: worker.verificationStatus || 'not_submitted', identityType: worker.identityType || null,
    identityLast4: worker.identityLast4 || null, reviewNote: worker.reviewNote || '',
    identitySubmittedAt: worker.identitySubmittedAt || null, identityReviewedAt: worker.identityReviewedAt || null,
    payoutSummary: worker.payoutSummary || null, wallet: worker.wallet || {},
  };
}
function historyBooking(b) {
  return { bookingId: String(b._id), service: b.service, date: b.date, time: b.time,
    address: b.address, status: b.status, createdAt: b.createdAt,
    completedAt: b.completedAt || null, quotedAmountPaise: b.quotedAmountPaise,
    paymentMethod: b.paymentMethod, paymentStatus: b.paymentStatus,
    paymentUpdatedAt: b.paymentUpdatedAt || null,
    paidAt: b.paidAt || (b.paymentStatus === 'paid' ? b.paymentUpdatedAt : null),
    paymentReference: b.razorpayPaymentId || null, paymentHistory: b.paymentHistory || [],
    assignedWorkerName: b.assignedWorkerName || null,
    cashCollection: b.cashCollection || null, alternatePhone: b.alternatePhone || null };
}

function registerTeamHistory({ app, mongoose, Booking, Customer, requireAdminKey, requireCustomer, customerLocalPhone }) {
  const workerSchema = new mongoose.Schema({
    name: { type: String, required: true, maxlength: 100 },
    phone: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    salt: { type: String, required: true, select: false },
    active: { type: Boolean, default: true },
    sessionVersion: { type: Number, default: 0 },
    verificationStatus: { type: String, enum: ['not_submitted','pending','approved','rejected'], default: 'not_submitted' },
    identityEncrypted: { type: mongoose.Schema.Types.Mixed, select: false },
    payoutEncrypted: { type: mongoose.Schema.Types.Mixed, select: false },
    identitySubmissionId: { type: String, select: false }, privateViewedSubmissionId: { type: String, select: false },
    identityType: String, identityLast4: String, identitySubmittedAt: Date, identityReviewedAt: Date,
    reviewNote: String, payoutSummary: String, payoutUpdatedAt: Date, privateViewedAt: Date,
    wallet: {
      grossPaise: { type: Number, default: 0 }, commissionPaise: { type: Number, default: 0 },
      earnedPaise: { type: Number, default: 0 }, cashHeldPaise: { type: Number, default: 0 },
      balancePaise: { type: Number, default: 0 }, reservedPaise: { type: Number, default: 0 },
      withdrawnPaise: { type: Number, default: 0 }, settledJobs: { type: Number, default: 0 },
      remittedPaise: { type: Number, default: 0 },
    },
  }, { timestamps: true });
  const Worker = mongoose.models.Worker || mongoose.model('Worker', workerSchema);
  const failures = new Map();
  // Bound memory and expire rate-limit entries without retaining credentials.
  function limit(ip) {
    const now = Date.now();
    for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
    const record = failures.get(ip) || { count: 0, until: now + 15 * 60000 };
    if (record.count >= 8 || (failures.size >= 10000 && !failures.has(ip))) return false;
    record.count++;
    failures.set(ip, record);
    return true;
  }
  const wrap = fn => async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (_) { res.status(500).json({ message: 'Unable to complete the request. Please try again.' }); }
  };
  const requireWorker = wrap(async (req, res, next) => {
    const match = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    const payload = verifyWorkerToken(match?.[1], process.env.ADMIN_SESSION_SECRET);
    if (!payload || !mongoose.isValidObjectId(payload.sub)) {
      return res.status(401).json({ message: 'Please sign in again.' });
    }
    const worker = await Worker.findOne({ _id: payload.sub, active: true,
      sessionVersion: payload.version }).lean();
    if (!worker) return res.status(401).json({ message: 'Please sign in again.' });
    req.worker = worker;
    next();
  });

  app.post('/api/worker/login', wrap(async (req, res) => {
    if (!process.env.ADMIN_SESSION_SECRET) return res.status(503).json({ message: 'Worker login is not configured.' });
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!limit(ip)) return res.status(429).json({ message: 'Too many attempts. Try again in 15 minutes.' });
    const phone = String(req.body?.phone || '').trim();
    const password = req.body?.password;
    if (!/^\d{10}$/.test(phone) || typeof password !== 'string' || password.length > 128) {
      return res.status(401).json({ message: 'Invalid phone or password.' });
    }
    const worker = await Worker.findOne({ phone, active: true }).select('+passwordHash +salt');
    const salt = worker?.salt || 'invalid-worker-salt';
    const candidate = await hashPassword(password, salt);
    const expected = worker?.passwordHash || '0'.repeat(128);
    if (!crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) {
      return res.status(401).json({ message: 'Invalid phone or password.' });
    }
    failures.delete(ip);
    return res.json({ token: signWorkerToken(worker, process.env.ADMIN_SESSION_SECRET),
      worker: publicWorker(worker), expiresIn: 28800 });
  }));

  app.get('/api/admin/workers', requireAdminKey, wrap(async (_req, res) => {
    const workers = await Worker.find().sort({ name: 1 }).lean();
    res.json({ workers: workers.map(publicWorker) });
  }));
  app.post('/api/admin/workers', requireAdminKey, wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const password = req.body?.password;
    if (!name || name.length > 100 || !/^\d{10}$/.test(phone) ||
        typeof password !== 'string' || password.length < 10 || password.length > 128) {
      return res.status(400).json({ message: 'Enter a name, 10-digit phone, and password of 10–128 characters.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    try {
      const worker = await Worker.create({ name, phone, salt, passwordHash: await hashPassword(password, salt) });
      return res.status(201).json({ worker: publicWorker(worker) });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ message: 'A worker with this phone already exists.' });
      throw error;
    }
  }));
  app.patch('/api/admin/workers/:id', requireAdminKey, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid worker ID.' });
    const update = {};
    if (typeof req.body?.active === 'boolean') update.active = req.body.active;
    if (req.body?.password !== undefined) {
      const password = req.body.password;
      if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
        return res.status(400).json({ message: 'Use a password of 10–128 characters.' });
      }
      update.salt = crypto.randomBytes(16).toString('hex');
      update.passwordHash = await hashPassword(password, update.salt);
    }
    if (!Object.keys(update).length) return res.status(400).json({ message: 'No valid changes supplied.' });
    const worker = await Worker.findByIdAndUpdate(req.params.id,
      { $set: update, $inc: { sessionVersion: 1 } }, { new: true, runValidators: true });
    if (!worker) return res.status(404).json({ message: 'Worker not found.' });
    res.json({ worker: publicWorker(worker) });
  }));
  app.patch('/api/admin/bookings/:id/assignment', requireAdminKey, wrap(async (req, res) => {
    const workerId = req.body?.workerId;
    if (!mongoose.isValidObjectId(req.params.id) ||
        (workerId !== null && !mongoose.isValidObjectId(workerId))) {
      return res.status(400).json({ message: 'Invalid booking or worker ID.' });
    }
    const worker = workerId === null ? null : await Worker.findOne({ _id: workerId, active: true, verificationStatus: 'approved', payoutSummary: { $exists: true, $nin: [null, ''] } });
    if (workerId !== null && !worker) return res.status(404).json({ message: 'Worker must be active and identity-approved before assignment.' });
    const booking = await Booking.findOneAndUpdate({ _id: req.params.id,
      status: { $nin: ['completed', 'cancelled'] } }, { $set: {
        assignedWorkerId: worker?._id || null, assignedWorkerName: worker?.name || null,
        assignedAt: worker ? new Date() : null, cashCollection: null,
      } }, { new: true, runValidators: true });
    if (!booking) return res.status(409).json({ message: 'Booking not found or already closed.' });
    res.json({ bookingId: String(booking._id), assignedWorkerId: booking.assignedWorkerId,
      assignedWorkerName: booking.assignedWorkerName });
  }));
  app.get('/api/worker/bookings', requireWorker, wrap(async (req, res) => {
    if ((req.worker.verificationStatus !== 'approved' || !req.worker.payoutSummary)) return res.json({ worker: publicWorker(req.worker), bookings: [], hasMore: false, needsVerification: true });
    const limit = 50;
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
    const bookings = await Booking.find({ assignedWorkerId: req.worker._id, status: { $ne: 'cancelled' } })
      .select('customerName phone alternatePhone address service date time status completedAt assignedAt quotedAmountPaise paymentMethod paymentStatus cashCollection')
      .sort({ assignedAt: -1 }).skip((page - 1) * limit).limit(limit + 1).lean();
    res.json({ worker: publicWorker(req.worker), bookings: bookings.slice(0, limit), hasMore: bookings.length > limit });
  }));
  app.patch('/api/worker/bookings/:id/status', requireWorker, wrap(async (req, res) => {
    if ((req.worker.verificationStatus !== 'approved' || !req.worker.payoutSummary)) return res.status(403).json({ message: 'Identity approval and payout details are required before working on jobs.' });
    const status = req.body?.status;
    if (!mongoose.isValidObjectId(req.params.id) || !['accepted', 'completed'].includes(status)) {
      return res.status(400).json({ message: 'Choose accepted or completed.' });
    }
    const allowed = status === 'accepted' ? ['pending'] : ['accepted'];
    const booking = await Booking.findOneAndUpdate({ _id: req.params.id,
      assignedWorkerId: req.worker._id, status: { $in: allowed } },
      { $set: { status, ...(status === 'completed' ? { completedAt: new Date() } : {}) } },
      { new: true, runValidators: true });
    if (!booking) return res.status(409).json({ message: 'Job changed or is no longer assigned to you. Refresh your jobs.' });
    res.json({ bookingId: String(booking._id), status: booking.status, completedAt: booking.completedAt });
  }));

  // Workers can request a cash receipt; only the authenticated customer can confirm it.
  app.post('/api/worker/bookings/:id/cash-request', requireWorker, wrap(async (req, res) => {
    if ((req.worker.verificationStatus !== 'approved' || !req.worker.payoutSummary)) return res.status(403).json({ message: 'Identity approval and payout details are required.' });
    if (!mongoose.isValidObjectId(req.params.id) || !Number.isSafeInteger(req.body?.amountPaise) || req.body.amountPaise <= 0) {
      return res.status(400).json({ message: 'Invalid booking or amount.' });
    }
    const booking = await Booking.findOneAndUpdate({ _id: req.params.id,
      assignedWorkerId: req.worker._id, status: 'completed', paymentMethod: 'cash_on_service',
      paymentStatus: 'pending_collection', quotedAmountPaise: req.body.amountPaise,
      'cashCollection.status': { $ne: 'awaiting_customer' } },
      { $set: { cashCollection: { workerId: req.worker._id, workerName: req.worker.name,
        status: 'awaiting_customer', amountPaise: req.body.amountPaise, requestedAt: new Date() } } },
      { new: true, runValidators: true });
    if (!booking) return res.status(409).json({ message: 'Cash confirmation is already requested or this job is not eligible. Refresh jobs.' });
    res.json({ message: 'Ask the customer to open My Account → Service history and confirm cash paid.',
      cashCollection: booking.cashCollection });
  }));
  app.post('/api/customer/bookings/:id/cash-confirm', requireCustomer, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id) || !Number.isSafeInteger(req.body?.amountPaise)) {
      return res.status(400).json({ message: 'Invalid booking or amount.' });
    }
    const now = new Date();
    const booking = await Booking.findOneAndUpdate({ _id: req.params.id,
      customerUid: req.customer.uid, status: 'completed', paymentMethod: 'cash_on_service',
      paymentStatus: 'pending_collection', quotedAmountPaise: req.body.amountPaise,
      'cashCollection.status': 'awaiting_customer', 'cashCollection.amountPaise': req.body.amountPaise,
      $expr: { $eq: ['$assignedWorkerId', '$cashCollection.workerId'] } },
      { $set: { paymentStatus: 'paid', paidAt: now, paymentUpdatedAt: now,
        'cashCollection.status': 'customer_confirmed', 'cashCollection.confirmedAt': now },
        $push: { paymentHistory: { status: 'paid', method: 'cash_on_service',
          amountPaise: req.body.amountPaise, recordedAt: now } } },
      { new: true, runValidators: true });
    if (!booking) return res.status(409).json({ message: 'Payment changed or no cash confirmation is awaiting you. Refresh history.' });
    res.json({ message: 'Cash payment confirmed.', booking: historyBooking(booking) });
  }));

  require('./business-tools').registerBusinessTools({
    app, mongoose, Booking, Worker, Customer, requireAdminKey, requireCustomer,
    requireWorker, wrap, hashPassword, publicWorker, limit,
  });

  app.get('/api/customer/bookings', requireCustomer, wrap(async (req, res) => {
    const phone = customerLocalPhone(req.customer.phoneNumber);
    if (phone) {
      await Booking.updateMany({ phone, $or: [{ customerUid: { $exists: false } }, { customerUid: null }] },
        { $set: { customerUid: req.customer.uid } });
    }
    const owner = { customerUid: req.customer.uid };
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
    const limit = 20;
    const [bookings, totals] = await Promise.all([
      Booking.find(owner).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit + 1).lean(),
      Booking.aggregate([{ $match: owner }, { $group: { _id: null, totalOrders: { $sum: 1 },
        completedServices: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        totalPaidPaise: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, { $ifNull: ['$quotedAmountPaise', 0] }, 0] } },
      } }]),
    ]);
    const summary = totals[0] || { totalOrders: 0, completedServices: 0, totalPaidPaise: 0 };
    delete summary._id;
    res.json({ summary, bookings: bookings.slice(0, limit).map(historyBooking), hasMore: bookings.length > limit });
  }));
}
module.exports = { registerTeamHistory, verifyWorkerToken, signWorkerToken, hashPassword, historyBooking };
