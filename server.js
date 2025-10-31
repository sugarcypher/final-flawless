// server.js — v5 Stripe + Email integration
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

// Helper to read secrets from Render secret files or env vars
function getSecret(name, renderFilename) {
  // Try env var first (standard naming)
  if (process.env[name]) {
    const val = String(process.env[name]).trim();
    if (val) return val;
  }
  // Try Render secret file env var (Render exposes secret files as env vars with filename)
  if (renderFilename && process.env[renderFilename]) {
    const val = String(process.env[renderFilename]).trim();
    if (val) return val;
  }
  // Try Render secret file path (fallback)
  if (renderFilename) {
    try {
      const secretPath = `/etc/secrets/${renderFilename}`;
      if (fs.existsSync(secretPath)) {
        return fs.readFileSync(secretPath, 'utf8').trim();
      }
    } catch (e) {
      // File doesn't exist or can't read
    }
  }
  return null;
}

// Initialize Stripe with fallback for missing keys
// Support both STRIPE_SECRET_KEY/SEC_KEY env vars and Render secret files
const stripeSecretKey = getSecret('STRIPE_SECRET_KEY', 'SEC_KEY') || getSecret('SEC_KEY', null);
const stripe = stripeSecretKey ? require('stripe')(stripeSecretKey) : null;
if (!stripe) {
  console.warn('⚠️  STRIPE_SECRET_KEY/SEC_KEY not found (env or /etc/secrets/SEC_KEY) - payment features will be disabled');
  console.log('Available env vars:', Object.keys(process.env).filter(k => k.includes('SEC') || k.includes('STRIPE')).join(', ') || 'none');
} else {
  console.log('✓ Stripe initialized with secret key');
}
// Support both STRIPE_PUBLISHABLE_KEY/PUB_KEY env vars and Render secret files
const stripePublishableKey = getSecret('STRIPE_PUBLISHABLE_KEY', 'PUB_KEY') || getSecret('PUB_KEY', null);
if (!stripePublishableKey) {
  console.warn('⚠️  STRIPE_PUBLISHABLE_KEY/PUB_KEY not found (env or /etc/secrets/PUB_KEY) - payment button will show as not configured');
  console.log('Available env vars:', Object.keys(process.env).filter(k => k.includes('PUB') || k.includes('STRIPE')).join(', ') || 'none');
} else {
  console.log('✓ Stripe publishable key available');
}

const app = express();

// Trust proxy for rate limiting behind reverse proxy (Render, Cloudflare, etc.)
app.set('trust proxy', 1);

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(helmet.hsts({ maxAge: 15552000, includeSubDomains: true, preload: true }));
app.use(helmet.referrerPolicy({ policy: 'no-referrer' }));
// Set modern Permissions-Policy header (Helmet no longer provides an API for this)
app.use((_, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    [
      'geolocation=()',
      'camera=()',
      'microphone=()',
      'usb=()',
      'payment=(self)',
      'fullscreen=(self)'
    ].join(', ')
  );
  next();
});
// Basic CSP, allow our domain and Stripe for payments
app.use(helmet.contentSecurityPolicy({
  useDefaults: true,
  directives: {
    "default-src": ["'self'"],
    // Allow inline scripts for the existing inline calendar/payment code
    "script-src": ["'self'", "'unsafe-inline'", 'https://js.stripe.com'],
    "frame-src": ["'self'", 'https://js.stripe.com'],
    "connect-src": ["'self'"],
    "img-src": ["'self'", 'data:'],
    "style-src": ["'self'", "'unsafe-inline'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"]
  }
}));
app.use(compression());

// Restrictive CORS configuration with whitelist
const defaultAllowedOrigins = [
  'https://flawlessfini.sh',
  'https://www.flawlessfini.sh',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
const envAllowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const allowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...envAllowed]));

app.use(cors({
  origin: function(origin, callback) {
    // Block requests with no origin (like curl) by default
    if (!origin) return callback(null, false);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Cookies for user preferences (signed)
app.use(cookieParser(process.env.COOKIE_SECRET || 'change-me'));
app.disable('x-powered-by');

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(limiter);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

// ── Preferences API ────────────────────────────────────────────────────────────
// Shape: { functional: true, analytics: false, marketing: false, communications: 'sms'|'email'|'none' }
app.get('/api/preferences', (req, res) => {
  try {
    const raw = req.signedCookies?.ff_prefs;
    const prefs = raw ? JSON.parse(raw) : null;
    return res.json({
      success: true,
      preferences: Object.assign({ functional: true, analytics: false, marketing: false, communications: 'none' }, prefs || {})
    });
  } catch {
    return res.json({ success: true, preferences: { functional: true, analytics: false, marketing: false, communications: 'none' } });
  }
});

app.post('/api/preferences', (req, res) => {
  try {
    const { functional = true, analytics = false, marketing = false, communications = 'none' } = req.body || {};
    const sanitized = {
      functional: Boolean(functional),
      analytics: Boolean(analytics),
      marketing: Boolean(marketing),
      communications: ['sms','email','none'].includes(communications) ? communications : 'none'
    };
    res.cookie('ff_prefs', JSON.stringify(sanitized), {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      signed: true,
      maxAge: 31536000000 // 1 year
    });
    return res.json({ success: true, preferences: sanitized });
  } catch (e) {
    return res.status(400).json({ success: false, message: 'Invalid preferences' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function readBookings() {
  try {
    if (!fs.existsSync(BOOKINGS_FILE)) return [];
    return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function writeBookings(bookings) {
  try {
    fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
  } catch {}
}
function toYMD(d) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// HTML-escape helper to prevent injection in email templates
function escapeHtml(input) {
  const str = String(input ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Helper to sanitize a phone number for use in a tel: href
function sanitizePhoneForTelLink(phone) {
  // Only allow numbers, +, -, (, ), and spaces for tel: URIs
  return String(phone || '')
    .replace(/[^0-9+\-\s\(\)]/g, '')
    .trim();
}

// ── Email Configuration ─────────────────────────────────────────────────────────
const emailConfig = {
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  connectionTimeout: 10000, // 10 seconds
  greetingTimeout: 10000,
  socketTimeout: 10000
};

const transporter = nodemailer.createTransport(emailConfig);
const jasonEmail = 'j@flawlessfini.sh';

async function sendEmailNotification(bookingData) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('Email skipped – Email credentials missing.');
    return;
  }
  
  try {
    const { customerName, customerPhone, customerEmail, selectedDate, timeSlot, vehicleInfo, depositAmount, serviceLevel } = bookingData;
    
    const mailOptions = {
      from: `"Flawless Finish Website" <${process.env.EMAIL_USER}>`,
      to: jasonEmail,
      subject: `New Booking - ${customerName} - ${selectedDate}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #FFD700; background: #0a0f1a; padding: 20px; margin: 0; text-align: center;">
            🚗 New Ceramic Coating Booking
          </h2>
          <div style="background: #f8f9fa; padding: 30px;">
            <h3 style="color: #0a0f1a; margin-top: 0;">Customer Information</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold; width: 30%;">Name:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(customerName)}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Phone:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(customerPhone)}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Email:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(customerEmail)}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Date:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(selectedDate)}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Time Slot:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(timeSlot ? timeSlot.charAt(0).toUpperCase() + timeSlot.slice(1) : 'Not specified')}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Vehicle:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(vehicleInfo || 'Not specified')}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Service:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(serviceLevel || 'Not specified')}</td>
              </tr>
              <tr>
                <td style="padding: 10px; font-weight: bold;">Deposit:</td>
                <td style="padding: 10px; color: #FFD700; font-weight: bold;">$${(depositAmount / 100).toFixed(2)}</td>
              </tr>
            </table>

            <div style="margin-top: 30px; padding: 20px; background: #e8f5e8; border-left: 4px solid #4CAF50;">
              <h4 style="margin: 0 0 10px 0; color: #2e7d32;">✅ Deposit Received</h4>
              <p style="margin: 0; color: #2e7d32;">The customer has successfully paid the $250 deposit to secure their booking.</p>
            </div>

            <div style="margin-top: 20px; text-align: center;">
              <a href="tel:${sanitizePhoneForTelLink(customerPhone)}" style="background: #FFD700; color: #0a0f1a; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                📞 Call Customer
              </a>
            </div>
          </div>

          <div style="background: #0a0f1a; color: #fff; padding: 20px; text-align: center; font-size: 12px;">
            <p style="margin: 0;">Flawless Finish Ceramic Coating - Palm Springs & Coachella Valley</p>
            <p style="margin: 5px 0 0 0;">This email was sent automatically from your website booking system.</p>
          </div>
        </div>
      `
    };

    // Race email send against timeout (10 seconds max)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Email send timeout after 10 seconds')), 10000);
    });
    
    const info = await Promise.race([
      transporter.sendMail(mailOptions),
      timeoutPromise
    ]);
    
    console.log('Email sent:', info.messageId);
  } catch (err) {
    console.error('Email error:', err?.message || err);
    // Don't block booking - email failure shouldn't prevent booking completion
  }
}

// ── API: availability (one car per day) ───────────────────────────────────────
app.get('/api/availability', (req, res) => {
  const days = parseInt(req.query.days || '30', 10);
  const bookings = readBookings();
  const now = new Date();
  now.setHours(0,0,0,0);

  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const dow = d.getDay(); // 0 Sun .. 6 Sat
    if (dow === 0) continue; // closed Sundays

    const ymd = toYMD(d);
    const booked = bookings.some(b => b.date === ymd);
    out.push({ date: ymd, booked });
  }
  res.json({ days: out });
});

// ── API: create payment intent ─────────────────────────────────────────────────
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ 
        success: false, 
        message: 'Payment system temporarily unavailable. Please contact us directly.' 
      });
    }

    const { date, name, phone } = req.body || {};
    if (!date) return res.status(400).json({ success: false, message: 'Please select a date.' });
    if (!name || name.trim().length === 0) return res.status(400).json({ success: false, message: 'Please enter your name.' });
    if (!phone || phone.trim().length === 0) return res.status(400).json({ success: false, message: 'Please enter your phone number.' });

    // Create Stripe payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 25000, // $250.00 in cents
      currency: 'usd',
      metadata: {
        // Keep metadata minimal to avoid storing PII in Stripe
        date: String(date).slice(0, 10),
        service: 'Flawless Finish Ceramic Coating Deposit'
      }
    });

    res.json({ 
      success: true, 
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ success: false, message: 'Payment processing error.' });
  }
});

// ── API: confirm payment and book ──────────────────────────────────────────────
app.post('/api/confirm-payment', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ 
        success: false, 
        message: 'Payment system temporarily unavailable. Please contact us directly.' 
      });
    }

    const { paymentIntentId, date, name, phone, timeSlot, vehicleYear, vehicleMake, vehicleModel, vehicleTrim, vehicleColor, serviceLevel } = req.body || {};
    
    if (!paymentIntentId || !date) {
      return res.status(400).json({ success: false, message: 'Missing payment or date information.' });
    }

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ success: false, message: 'Payment not completed.' });
    }

    // Sanitize input
    const sanitizedDate = String(date).slice(0, 10);
    const sanitizedName = String(name || '').slice(0, 80);
    const sanitizedPhone = String(phone || '').slice(0, 40);
    const vehicleSummary = [vehicleYear, vehicleMake, vehicleModel, vehicleTrim, vehicleColor]
      .map(x => (x == null ? '' : String(x).trim()))
      .filter(Boolean)
      .join(' ');

    const bookings = readBookings();
    if (bookings.some(b => b.date === sanitizedDate)) {
      return res.status(409).json({ success: false, message: 'That day is already booked.' });
    }

    // Save only the booked date and non-PII details
    bookings.push({ 
      date: sanitizedDate,
      method: 'card',
      deposit: 250,
      createdAt: new Date().toISOString() 
    });
    writeBookings(bookings);

    // Notify Jason by email
    const humanDate = new Date(sanitizedDate + 'T12:00:00').toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', timeZone: 'America/Los_Angeles' });
    await sendEmailNotification({
      customerName: sanitizedName || 'N/A',
      customerPhone: sanitizedPhone || 'N/A',
      customerEmail: 'Not provided',
      selectedDate: humanDate,
      timeSlot: timeSlot || 'Not specified',
      vehicleInfo: vehicleSummary || 'Not specified',
      serviceLevel: serviceLevel || 'Not specified',
      depositAmount: 25000,
      paymentMethod: 'Stripe Card',
      stripePaymentId: paymentIntentId
    });

    return res.json({ 
      success: true, 
      message: 'Payment confirmed and booking saved.', 
      date: sanitizedDate, 
      method: 'card',
      paymentId: paymentIntentId
    });
  } catch (error) {
    console.error('Payment confirmation error:', error);
    res.status(500).json({ success: false, message: 'Payment confirmation failed.' });
  }
});

// ── API: book cash reservation ────────────────────────────────────────────────
app.post('/api/book-cash', async (req, res) => {
  let { date, name, phone, timeSlot, vehicleYear, vehicleMake, vehicleModel, vehicleTrim, vehicleColor, serviceLevel } = req.body || {};
  if (!date) return res.status(400).json({ success: false, message: 'Please select a date.' });
  if (!name || name.trim().length === 0) return res.status(400).json({ success: false, message: 'Please enter your name.' });
  if (!phone || phone.trim().length === 0) return res.status(400).json({ success: false, message: 'Please enter your phone number.' });

  // sanitize input
  const sanitizedDate = String(date).slice(0, 10); // YYYY-MM-DD
  const sanitizedName = typeof name === 'string' ? name.slice(0, 80) : '';
  const sanitizedPhone = typeof phone === 'string' ? phone.slice(0, 40) : '';
  const vehicleSummary = [vehicleYear, vehicleMake, vehicleModel, vehicleTrim, vehicleColor]
    .map(x => (x == null ? '' : String(x).trim()))
    .filter(Boolean)
    .join(' ');

  const bookings = readBookings();
  if (bookings.some(b => b.date === sanitizedDate)) {
    return res.status(409).json({ success: false, message: 'That day is already booked.' });
  }

  // Save only the booked date and non-PII details
  bookings.push({ 
    date: sanitizedDate,
    method: 'cash', 
    deposit: 0, 
    createdAt: new Date().toISOString() 
  });
  writeBookings(bookings);

  // Notify Jason by email
  const humanDate = new Date(sanitizedDate + 'T12:00:00').toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', timeZone: 'America/Los_Angeles' });
  await sendEmailNotification({
    customerName: sanitizedName || 'N/A',
    customerPhone: sanitizedPhone || 'N/A',
    customerEmail: 'Not provided',
    selectedDate: humanDate,
    timeSlot: timeSlot || 'Not specified',
    vehicleInfo: vehicleSummary || 'Not specified',
    serviceLevel: serviceLevel || 'Not specified',
    depositAmount: 0,
    paymentMethod: 'Cash Reservation',
    stripePaymentId: 'N/A'
  });

  return res.json({ success: true, message: 'Cash reservation saved.', date: sanitizedDate, method: 'cash' });
});

// ── API: get Stripe publishable key ───────────────────────────────────────────
app.get('/api/stripe-key', (_, res) => {
  // Support both STRIPE_PUBLISHABLE_KEY/PUB_KEY env vars and Render secret files
  const key = getSecret('STRIPE_PUBLISHABLE_KEY', 'PUB_KEY') || getSecret('PUB_KEY', null) || '';
  if (!key) {
    console.warn('STRIPE_PUBLISHABLE_KEY/PUB_KEY not found (env or /etc/secrets/PUB_KEY)');
    console.log('Checking env vars:', {
      STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY ? 'exists' : 'missing',
      PUB_KEY: process.env.PUB_KEY ? 'exists' : 'missing'
    });
  }
  res.json({ publishableKey: key });
});

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flawless Finish server running on ${PORT}`));
