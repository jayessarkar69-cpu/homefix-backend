
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const crypto = require('crypto');
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
app.post('/api/bookings/status', requireCustomer, async (req, res) => {
  try {
    const bookingId = String(req.body.bookingId || '').trim();
    const phone = String(req.body.phone || '').trim();

    if (!mongoose.isValidObjectId(bookingId) ||
        !/^\d{10}$/.test(phone)) {
      return res.status(400).json({
        message: 'Enter a valid booking ID and 10-digit phone number.',
      });
    }

    const accountPhone = customerLocalPhone(req.customer.phoneNumber);
    if (!accountPhone || accountPhone !== phone) {
      return res.status(403).json({
        message: 'Use the phone number verified in your HomeFix account.'
      });
    }

    // Look up bookings owned by this signed-in customer.
    let booking = await Booking.findOne({
      _id: bookingId,
      phone,
      customerUid: req.customer.uid,
    })
      .select('service date time status createdAt')
      .lean();

    // Safely associate an older, unlinked booking only when its phone
    // matches this customer's verified Firebase phone number.
    if (!booking) {
      booking = await Booking.findOneAndUpdate(
        {
          _id: bookingId,
          phone,
          $or: [
            { customerUid: { $exists: false } },
            { customerUid: null },
          ],
        },
        { $set: { customerUid: req.customer.uid } },
        { new: true }
      )
        .select('service date time status createdAt')
        .lean();
    }

    if (!booking) {
      return res.status(404).json({
        message: 'Booking not found. Check your booking ID and phone number.',
      });
    }

    return res.json({
      bookingId: String(booking._id),
      service: booking.service,
      date: booking.date,
      time: booking.time,
      status: booking.status,
      createdAt: booking.createdAt,
    });
  } catch (error) {
    console.error('Customer status lookup error:', error.message);
    return res.status(500).json({
      message: 'Unable to check booking status right now.',
    });
  }
});

function safeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length &&
    crypto.timingSafeEqual(left, right);
}

function verifyAdminToken(token) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || typeof token !== 'string') return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

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
  } catch {
    return false;
  }
}

const adminLoginFailures = new Map();

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
