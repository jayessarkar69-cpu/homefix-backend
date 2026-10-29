
const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const crypto = require('crypto');

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
    status: {
      type: String,
      enum: ['pending', 'accepted', 'completed', 'cancelled'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

const Booking = mongoose.model('Booking', bookingSchema);

// Test route
app.get('/', (req, res) => {
  res.json({
    message: 'HomeFix backend is running!',
  });
});

// Create a booking
app.post('/api/bookings', async (req, res) => {
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

    const booking = await Booking.create({
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
app.post('/api/bookings/status', async (req, res) => {
  try {
    const bookingId = String(req.body.bookingId || '').trim();
    const phone = String(req.body.phone || '').trim();

    if (!mongoose.isValidObjectId(bookingId) ||
        !/^\d{10}$/.test(phone)) {
      return res.status(400).json({
        message: 'Enter a valid booking ID and 10-digit phone number.',
      });
    }

    const booking = await Booking.findOne({
      _id: bookingId,
      phone: phone,
    })
      .select('service date time status createdAt')
      .lean();

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
