
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const bookingSchema = new mongoose.Schema(
  {
    customerName: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    service: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: String,
      required: true,
    },
    time: {
      type: String,
      required: true,
    },
    problem: {
      type: String,
      default: '',
      trim: true,
    },
    customerUid: { type: String, required: false, index: true },
    quotedAmountPaise: { type: Number, min: 0, default: null },
    paymentMethod: {
      type: String,
      enum: ['cash_on_service', 'razorpay'],
      default: null,
    },
    paymentStatus: {
      type: String,
      enum: ['not_started', 'pending_collection', 'created', 'authorized', 'paid', 'failed'],
      default: 'not_started',
    },
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    paymentUpdatedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'completed', 'cancelled'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

const Booking = mongoose.model('Booking', bookingSchema);

const customerAddressSchema = new mongoose.Schema({
  label: { type: String, trim: true, default: 'Home', maxlength: 40 },
  addressLine1: { type: String, required: true, trim: true, maxlength: 200 },
  addressLine2: { type: String, trim: true, default: '', maxlength: 200 },
  landmark: { type: String, trim: true, default: '', maxlength: 120 },
  city: { type: String, required: true, trim: true, maxlength: 80 },
  state: { type: String, required: true, trim: true, maxlength: 80 },
  postalCode: { type: String, required: true, trim: true, match: /^[0-9]{6}$/ },
  isDefault: { type: Boolean, default: false }
});

const customerSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: '', trim: true, maxlength: 80 },
  phone: { type: String, default: '', trim: true },
  email: { type: String, default: '', trim: true, lowercase: true, maxlength: 254 },
  addresses: { type: [customerAddressSchema], default: [] }
}, { timestamps: true });

const Customer = mongoose.model('Customer', customerSchema);


let customerFirebaseAuth = null;

try {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (encoded) {
    const serviceAccount = JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf8')
    );
    if (!getApps().length) {
      initializeApp({ credential: cert(serviceAccount) });
    }
    customerFirebaseAuth = getAuth();
    console.log('Firebase customer authentication initialized.');
  } else {
    console.warn('Firebase customer authentication is not configured.');
  }
} catch (error) {
  console.error('Firebase Admin initialization failed:', error.message);
}

async function requireCustomer(req, res, next) {
  if (!customerFirebaseAuth) {
    return res.status(503).json({
      message: 'Customer authentication is temporarily unavailable.'
    });
  }

  const match = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({
      message: 'Please sign in to continue.'
    });
  }

  try {
    const decoded = await customerFirebaseAuth.verifyIdToken(match[1]);
    req.customer = {
      uid: decoded.uid,
      phoneNumber: decoded.phone_number || null,
      email: decoded.email || null
    };
    return next();
  } catch (_) {
    return res.status(401).json({
      message: 'Your sign-in has expired. Please sign in again.'
    });
  }
}

function customerLocalPhone(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}


// Customer's own profile. Firebase UID comes only from the verified ID token.
app.get('/api/customer/me', requireCustomer, async (req, res) => {
  try {
    const updates = { phone: req.customer.phoneNumber || '' };
    if (req.customer.email) updates.email = req.customer.email;

    const customer = await Customer.findOneAndUpdate(
      { firebaseUid: req.customer.uid },
      { $set: updates, $setOnInsert: { firebaseUid: req.customer.uid } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();

    return res.json({ customer });
  } catch (error) {
    console.error('Customer profile read error:', error.message);
    return res.status(500).json({ message: 'Unable to load your profile.' });
  }
});

// Update permitted profile fields. The verified phone cannot be edited here.
app.patch('/api/customer/me', requireCustomer, async (req, res) => {
  try {
    const updates = {};

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim().length > 80) {
        return res.status(400).json({ message: 'Name must be 80 characters or fewer.' });
      }
      updates.name = req.body.name.trim();
    }

    if (req.body.email !== undefined) {
      if (typeof req.body.email !== 'string' || req.body.email.length > 254) {
        return res.status(400).json({ message: 'Enter a valid email address.' });
      }
      const email = req.body.email.trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: 'Enter a valid email address.' });
      }
      updates.email = email;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: 'Provide a name or email to update.' });
    }

    const customer = await Customer.findOneAndUpdate(
      { firebaseUid: req.customer.uid },
      {
        $set: { ...updates, phone: req.customer.phoneNumber || '' },
        $setOnInsert: { firebaseUid: req.customer.uid }
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();

    return res.json({ message: 'Profile saved.', customer });
  } catch (error) {
    console.error('Customer profile update error:', error.message);
    return res.status(500).json({ message: 'Unable to save your profile.' });
  }
});

// Add a saved service address for the signed-in customer.
app.post('/api/customer/addresses', requireCustomer, async (req, res) => {
  try {
    const body = req.body || {};
    const addressLine1 = typeof body.addressLine1 === 'string' ? body.addressLine1.trim() : '';
    const city = typeof body.city === 'string' ? body.city.trim() : '';
    const state = typeof body.state === 'string' ? body.state.trim() : '';
    const postalCode = typeof body.postalCode === 'string' ? body.postalCode.trim() : '';

    if (!addressLine1 || !city || !state || !/^[0-9]{6}$/.test(postalCode)) {
      return res.status(400).json({
        message: 'Address line, city, state, and a valid six-digit PIN code are required.'
      });
    }

    const customer = await Customer.findOneAndUpdate(
      { firebaseUid: req.customer.uid },
      {
        $set: { phone: req.customer.phoneNumber || '' },
        $setOnInsert: { firebaseUid: req.customer.uid }
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    const makeDefault = body.isDefault === true || customer.addresses.length === 0;
    if (makeDefault) {
      customer.addresses.forEach(address => { address.isDefault = false; });
    }

    customer.addresses.push({
      label: typeof body.label === 'string' ? body.label.trim().slice(0, 40) || 'Home' : 'Home',
      addressLine1,
      addressLine2: typeof body.addressLine2 === 'string' ? body.addressLine2.trim().slice(0, 200) : '',
      landmark: typeof body.landmark === 'string' ? body.landmark.trim().slice(0, 120) : '',
      city,
      state,
      postalCode,
      isDefault: makeDefault
    });

    await customer.save();
    const savedAddress = customer.addresses[customer.addresses.length - 1];

    return res.status(201).json({
      message: 'Address saved.',
      address: savedAddress
    });
  } catch (error) {
    console.error('Customer address save error:', error.message);
    return res.status(500).json({ message: 'Unable to save this address.' });
  }
});

// Delete only an address belonging to the signed-in customer.
app.delete('/api/customer/addresses/:addressId', requireCustomer, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.addressId)) {
      return res.status(400).json({ message: 'Invalid address ID.' });
    }

    const customer = await Customer.findOne({ firebaseUid: req.customer.uid });
    if (!customer) {
      return res.status(404).json({ message: 'Customer profile not found.' });
    }

    const address = customer.addresses.id(req.params.addressId);
    if (!address) {
      return res.status(404).json({ message: 'Address not found.' });
    }

    const wasDefault = address.isDefault;
    customer.addresses.pull({ _id: req.params.addressId });

    if (customer.addresses.length && (wasDefault || !customer.addresses.some(a => a.isDefault))) {
      customer.addresses.forEach((a, index) => { a.isDefault = index === 0; });
    }

    await customer.save();
    return res.json({ message: 'Address deleted.', addresses: customer.addresses });
  } catch (error) {
    console.error('Customer address delete error:', error.message);
    return res.status(500).json({ message: 'Unable to delete this address.' });
  }
});

// Test route
app.get('/', (req, res) => {
  res.json({
    message: 'HomeFix backend is running!',
  });
});

// Create a booking
app.post('/api/bookings', requireCustomer, async (req, res) => {
  try {
    const {
      customerName,
      phone,
      address,
      service,
      date,
      time,
      problem,
    } = req.body;

    if (
      !customerName ||
      !/^\d{10}$/.test(String(phone || '')) ||
      !address ||
      !service ||
      !date ||
      !time
    ) {
      return res.status(400).json({
        message: 'Please provide valid booking details.',
      });
    }

    const accountPhone = customerLocalPhone(req.customer.phoneNumber);
    if (!accountPhone || accountPhone !== String(phone)) {
      return res.status(403).json({
        message: 'Use the phone number verified in your HomeFix account.'
      });
    }

    const booking = await Booking.create({
      customerUid: req.customer.uid,
      customerName,
      phone: String(phone),
      address,
      service,
      date,
      time,
      problem: problem || '',
    });

    return res.status(201).json({
      message: 'Booking saved successfully!',
      bookingId: booking._id,
      status: booking.status,
    });
  } catch (error) {
    console.error('Booking error:', error.message);

    return res.status(500).json({
      message: 'Unable to save the booking right now.',
    });
  }
});

// Connect to MongoDB and start the server


// Allow customers to check their booking using their booking ID and phone.

// Select Cash on Service after Admin has set a quote.
app.post('/api/bookings/:id/payment/cash', requireCustomer, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid booking ID.' });
    }

    const booking = await Booking.findOne({
      _id: req.params.id,
      customerUid: req.customer.uid,
    });

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found.' });
    }
    if (booking.status === 'cancelled') {
      return res.status(409).json({ message: 'Cancelled bookings cannot be paid.' });
    }
    if (!Number.isSafeInteger(booking.quotedAmountPaise) ||
        booking.quotedAmountPaise <= 0) {
      return res.status(409).json({ message: 'Your service quote is not ready yet.' });
    }
    if (booking.paymentStatus === 'paid') {
      return res.status(409).json({ message: 'This booking is already paid.' });
    }

    booking.paymentMethod = 'cash_on_service';
    booking.paymentStatus = 'pending_collection';
    booking.razorpayOrderId = null;
    booking.razorpayPaymentId = null;
    booking.paymentUpdatedAt = new Date();
    await booking.save();

    return res.json({
      message: 'Cash on Service selected. Payment is due after service.',
      paymentMethod: booking.paymentMethod,
      paymentStatus: booking.paymentStatus,
      quotedAmountPaise: booking.quotedAmountPaise,
    });
  } catch (error) {
    console.error('Cash payment selection error:', error.message);
    return res.status(500).json({ message: 'Unable to select Cash on Service.' });
  }
});

// Create a Razorpay order using only the quote stored in MongoDB.
// Never accept the payable amount from the client.
app.post('/api/payments/razorpay/order', requireCustomer, async (req, res) => {
  try {
    const bookingId = String(req.body.bookingId || '').trim();
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ message: 'Invalid booking ID.' });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return res.status(503).json({ message: 'Online payments are not configured.' });
    }

    const booking = await Booking.findOne({
      _id: bookingId,
      customerUid: req.customer.uid,
    });

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found.' });
    }
    if (booking.status === 'cancelled') {
      return res.status(409).json({ message: 'Cancelled bookings cannot be paid.' });
    }
    if (!Number.isSafeInteger(booking.quotedAmountPaise) ||
        booking.quotedAmountPaise <= 0) {
      return res.status(409).json({ message: 'Your service quote is not ready yet.' });
    }
    if (booking.paymentStatus === 'paid') {
      return res.status(409).json({ message: 'This booking is already paid.' });
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await razorpay.orders.create({
      amount: booking.quotedAmountPaise,
      currency: 'INR',
      receipt: `hf_${booking._id}_${crypto.randomBytes(4).toString('hex')}`,
      notes: {
        bookingId: String(booking._id),
        customerUid: req.customer.uid,
      },
    });

    booking.paymentMethod = 'razorpay';
    booking.paymentStatus = 'created';
    booking.razorpayOrderId = order.id;
    booking.razorpayPaymentId = null;
    booking.paymentUpdatedAt = new Date();
    await booking.save();

    return res.status(201).json({
      keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      bookingId: String(booking._id),
      customerName: booking.customerName,
      phone: req.customer.phoneNumber || booking.phone,
    });
  } catch (error) {
    console.error('Razorpay order creation error:', error.message);
    return res.status(500).json({ message: 'Unable to start online payment.' });
  }
});

// Verify checkout signature, then confirm payment status with Razorpay.
// A client callback alone is never enough to mark a booking paid.
app.post('/api/payments/razorpay/verify', requireCustomer, async (req, res) => {
  try {
    const bookingId = String(req.body.bookingId || '').trim();
    const orderId = String(req.body.razorpay_order_id || '').trim();
    const paymentId = String(req.body.razorpay_payment_id || '').trim();
    const signature = String(req.body.razorpay_signature || '').trim();

    if (!mongoose.isValidObjectId(bookingId) ||
        !orderId || !paymentId || !/^[a-f0-9]{64}$/i.test(signature)) {
      return res.status(400).json({ message: 'Invalid payment verification details.' });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!process.env.RAZORPAY_KEY_ID || !keySecret) {
      return res.status(503).json({ message: 'Online payments are not configured.' });
    }

    const booking = await Booking.findOne({
      _id: bookingId,
      customerUid: req.customer.uid,
      paymentMethod: 'razorpay',
      razorpayOrderId: orderId,
    });

    if (!booking) {
      return res.status(404).json({ message: 'Payment order not found for this booking.' });
    }
    if (booking.paymentStatus === 'paid' &&
        booking.razorpayPaymentId === paymentId) {
      return res.json({ message: 'Payment already verified.', paymentStatus: 'paid' });
    }

    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest();
    const received = Buffer.from(signature, 'hex');

    if (expected.length !== received.length ||
        !crypto.timingSafeEqual(expected, received)) {
      return res.status(400).json({ message: 'Payment signature verification failed.' });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: keySecret,
    });
    const payment = await razorpay.payments.fetch(paymentId);

    if (payment.order_id !== orderId ||
        payment.amount !== booking.quotedAmountPaise ||
        payment.currency !== 'INR') {
      return res.status(400).json({ message: 'Payment does not match the booking quote.' });
    }

    if (payment.status !== 'captured') {
      booking.paymentStatus =
        payment.status === 'authorized' ? 'authorized' : 'failed';
      booking.razorpayPaymentId = paymentId;
      booking.paymentUpdatedAt = new Date();
      await booking.save();

      return res.status(409).json({
        message: payment.status === 'authorized'
          ? 'Payment is authorized but not captured yet. The booking is not marked paid.'
          : 'Payment has not been captured.',
        paymentStatus: booking.paymentStatus,
      });
    }

    booking.paymentStatus = 'paid';
    booking.razorpayPaymentId = paymentId;
    booking.paymentUpdatedAt = new Date();
    await booking.save();

    return res.json({
      message: 'Payment verified successfully.',
      paymentStatus: booking.paymentStatus,
      paymentId,
    });
  } catch (error) {
    console.error('Razorpay verification error:', error.message);
    return res.status(500).json({ message: 'Unable to verify the payment right now.' });
  }
});


app.post('/api/bookings/status', requireCustomer, async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();

    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({
        message: 'Enter your 10-digit mobile number.'
      });
    }

    const verifiedPhone = customerLocalPhone(req.customer.phoneNumber);

    if (!verifiedPhone || phone !== verifiedPhone) {
      return res.status(403).json({
        message: 'Enter the mobile number verified in your HomeFix account.'
      });
    }

    // Associate eligible legacy bookings using the verified phone number.
    await Booking.updateMany(
      {
        phone,
        $or: [
          { customerUid: { $exists: false } },
          { customerUid: null }
        ]
      },
      { $set: { customerUid: req.customer.uid } }
    );

    const bookings = await Booking.find({
      customerUid: req.customer.uid,
      phone
    })
      .select('service date time status createdAt quotedAmountPaise paymentMethod paymentStatus')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({
      bookings: bookings.map(booking => ({
        bookingId: String(booking._id),
        service: booking.service,
        date: booking.date,
        time: booking.time,
        status: booking.status,
        createdAt: booking.createdAt,
        quotedAmountPaise: booking.quotedAmountPaise,
        paymentMethod: booking.paymentMethod,
        paymentStatus: booking.paymentStatus,
        quotedAmountPaise: booking.quotedAmountPaise,
        paymentMethod: booking.paymentMethod,
        paymentStatus: booking.paymentStatus
      }))
    });
  } catch (error) {
    console.error('Customer status lookup error:', error.message);
    return res.status(500).json({
      message: 'Unable to check booking status right now.'
    });
  }
});



// Admin login security helpers.
const adminLoginFailures = new Map();

function safeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function verifyAdminToken(token) {
  const secret = process.env.ADMIN_SESSION_SECRET;

  if (!secret || typeof token !== 'string') {
    return false;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return false;
  }

  const [payloadPart, suppliedSignature] = parts;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payloadPart)
    .digest('base64url');

  if (!safeEqualStrings(suppliedSignature, expectedSignature)) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8')
    );

    return payload.role === 'admin' &&
      Number.isFinite(payload.exp) &&
      payload.exp > Math.floor(Date.now() / 1000);
  } catch (_) {
    return false;
  }
}


app.post('/api/admin/login', (req, res) => {
  const configuredPassword = process.env.ADMIN_LOGIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;

  if (!configuredPassword || !secret) {
    return res.status(503).json({
      message: 'Admin login is not configured.'
    });
  }

  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const record = adminLoginFailures.get(ip);

  if (record && record.blockedUntil > now) {
    return res.status(429).json({
      message: 'Too many failed attempts. Try again later.'
    });
  }

  if (!safeEqualStrings(req.body?.password, configuredPassword)) {
    const inWindow = record && now - record.windowStart < 15 * 60 * 1000;
    const failures = inWindow ? record.failures + 1 : 1;
    const windowStart = inWindow ? record.windowStart : now;

    adminLoginFailures.set(ip, {
      failures,
      windowStart,
      blockedUntil: failures >= 8 ? now + 15 * 60 * 1000 : 0
    });

    return res.status(failures >= 8 ? 429 : 401).json({
      message: failures >= 8
        ? 'Too many failed attempts. Try again later.'
        : 'Invalid credentials.'
    });
  }

  adminLoginFailures.delete(ip);

  const payloadPart = Buffer.from(JSON.stringify({
    role: 'admin',
    exp: Math.floor(now / 1000) + 8 * 60 * 60
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadPart)
    .digest('base64url');

  return res.json({
    token: `${payloadPart}.${signature}`,
    expiresIn: 28800
  });
});

function requireAdminKey(req, res, next) {
  const expectedKey = process.env.ADMIN_API_KEY;
  const providedKey = req.get('x-admin-key');

  // Preserve compatibility with the existing web admin.
  if (expectedKey && safeEqualStrings(providedKey, expectedKey)) {
    return next();
  }

  // Also allow a valid, unexpired token from the admin app.
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (match && verifyAdminToken(match[1])) {
    return next();
  }

  return res.status(401).json({ message: 'Unauthorized.' });
}


// Admin sets the service quote in rupees; backend stores the exact paise amount.
app.patch('/api/admin/bookings/:id/quote', requireAdminKey, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid booking ID.' });
    }

    const amount = req.body.amountRupees;
    if (typeof amount !== 'number' || !Number.isFinite(amount) ||
        amount < 1 || amount > 100000 ||
        Math.round(amount * 100) !== amount * 100) {
      return res.status(400).json({
        message: 'Enter a quote between ₹1 and ₹100,000 with at most two decimals.'
      });
    }

    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found.' });
    }
    if (booking.status === 'cancelled' || booking.paymentStatus === 'paid') {
      return res.status(409).json({
        message: 'Cannot change the quote for a cancelled or paid booking.'
      });
    }

    booking.quotedAmountPaise = Math.round(amount * 100);
    booking.paymentMethod = null;
    booking.paymentStatus = 'not_started';
    booking.razorpayOrderId = null;
    booking.razorpayPaymentId = null;
    booking.paymentUpdatedAt = new Date();
    await booking.save();

    return res.json({
      message: 'Service quote saved.',
      bookingId: String(booking._id),
      quotedAmountPaise: booking.quotedAmountPaise,
      currency: 'INR',
      paymentStatus: booking.paymentStatus,
    });
  } catch (error) {
    console.error('Admin quote update error:', error.message);
    return res.status(500).json({ message: 'Unable to save the service quote.' });
  }
});

// Admin confirms cash was actually collected after service.
app.post('/api/admin/bookings/:id/payment/cash/collect', requireAdminKey, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid booking ID.' });
    }

    const booking = await Booking.findOneAndUpdate(
      {
        _id: req.params.id,
        paymentMethod: 'cash_on_service',
        paymentStatus: 'pending_collection',
      },
      { $set: { paymentStatus: 'paid', paymentUpdatedAt: new Date() } },
      { new: true, runValidators: true }
    );

    if (!booking) {
      return res.status(409).json({
        message: 'No matching cash payment is awaiting collection.'
      });
    }

    return res.json({
      message: 'Cash collection recorded.',
      bookingId: String(booking._id),
      paymentStatus: booking.paymentStatus,
    });
  } catch (error) {
    console.error('Cash collection recording error:', error.message);
    return res.status(500).json({ message: 'Unable to record cash collection.' });
  }
});


app.get('/api/admin/bookings', requireAdminKey, async (req, res) => {
  try {
    const bookings = await Booking.find()
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.json({ bookings });
  } catch (error) {
    console.error('Admin bookings error:', error.message);
    return res.status(500).json({ message: 'Unable to load bookings.' });
  }
});

app.patch('/api/admin/bookings/:id/status', requireAdminKey, async (req, res) => {
  try {
    const allowedStatuses = ['pending', 'accepted', 'completed', 'cancelled'];
    const { status } = req.body;

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid booking ID.' });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid booking status.' });
    }

    const booking = await Booking.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true }
    );

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found.' });
    }

    return res.json({
      message: 'Booking status updated.',
      booking: {
        id: booking._id,
        status: booking.status,
      },
    });
  } catch (error) {
    console.error('Admin update error:', error.message);
    return res.status(500).json({ message: 'Unable to update booking.' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'admin.html'));
});

async function startServer() {
  try {
    const uri = process.env.MONGODB_URI;

    if (
      !uri ||
      !uri.startsWith('mongodb+srv://') ||
      uri.includes('REPLACE_WITH_YOUR_REAL_PASSWORD')
    ) {
      throw new Error(
        'Check MONGODB_URI in your .env file.'
      );
    }

    await mongoose.connect(uri);

    console.log('Connected to MongoDB successfully!');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `HomeFix backend running on port ${PORT}`
      );
    });
  } catch (error) {
    console.error('Startup failed:', error.message);
    process.exit(1);
  }
}

startServer();
