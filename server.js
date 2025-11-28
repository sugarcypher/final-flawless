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

// Initialize Stripe with fallback for missing keys
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) {
  console.warn('⚠️  STRIPE_SECRET_KEY not found - payment features will be disabled');
} else {
  console.log('✓ Stripe initialized with secret key');
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
// Support multiple recipient emails (comma-separated) via ADMIN_EMAIL env var, fallback to default
const recipientEmails = process.env.ADMIN_EMAIL 
  ? process.env.ADMIN_EMAIL.split(',').map(e => e.trim()).filter(Boolean)
  : ['j@flawlessfini.sh'];

// Log email configuration at startup
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  console.log('✓ Email service configured');
  console.log('  Recipient emails:', recipientEmails.join(', '));
  console.log('  From:', process.env.EMAIL_USER);
} else {
  console.warn('⚠️  Email service not configured (EMAIL_USER/EMAIL_PASS missing)');
}

// Send confirmation email to customer
async function sendCustomerConfirmationEmail(bookingData) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('Customer confirmation email skipped – Email credentials missing.');
    return;
  }
  
  const { customerName, customerEmail, selectedDate, vehicleInfo, serviceLevel, depositAmount, paymentMethod } = bookingData;
  
  if (!customerEmail || customerEmail === 'Not provided') {
    console.log('Customer confirmation email skipped – No customer email provided.');
    return;
  }
  
  try {
    const serviceLevelMap = {
      'minimal': 'Minimal Paint Correction - $800',
      'moderate': 'Moderate Paint Correction - $900',
      'heavy': 'Heavy Paint Correction - $1,100'
    };
    const serviceDisplay = serviceLevelMap[serviceLevel] || serviceLevel || 'Not specified';
    
    const mailOptions = {
      from: `"Flawless Finish Ceramic Coating" <${process.env.EMAIL_USER}>`,
      to: customerEmail,
      subject: `Booking Confirmed - ${selectedDate}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #FFD700; background: #0a0f1a; padding: 20px; margin: 0; text-align: center;">
            ✅ Booking Confirmed!
          </h2>
          <div style="background: #f8f9fa; padding: 30px;">
            <p style="font-size: 16px; color: #0a0f1a;">Hi ${escapeHtml(customerName)},</p>
            <p style="color: #0a0f1a;">Thank you for booking with Flawless Finish Ceramic Coating! Your appointment has been confirmed.</p>
            
            <div style="background: #fff; border: 2px solid #FFD700; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <h3 style="color: #0a0f1a; margin-top: 0;">Appointment Details</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold; width: 40%;">Date:</td>
                  <td style="padding: 10px; border-bottom: 1px solid #ddd; font-size: 18px; color: #0a0f1a;">${escapeHtml(selectedDate)}</td>
                </tr>
                <tr>
                  <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Service:</td>
                  <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(serviceDisplay)}</td>
                </tr>
                <tr>
                  <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Vehicle Type:</td>
                  <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(vehicleInfo || 'Not specified')}</td>
                </tr>
                ${depositAmount > 0 ? `
                <tr>
                  <td style="padding: 10px; font-weight: bold;">Deposit Paid:</td>
                  <td style="padding: 10px; color: #4CAF50; font-weight: bold; font-size: 18px;">$${(depositAmount / 100).toFixed(2)}</td>
                </tr>
                ` : ''}
              </table>
            </div>
            
            ${depositAmount > 0 ? `
            <div style="background: #e8f5e8; border-left: 4px solid #4CAF50; padding: 15px; margin: 20px 0;">
              <p style="margin: 0; color: #2e7d32;"><strong>✅ Deposit Received</strong></p>
              <p style="margin: 5px 0 0 0; color: #2e7d32;">Your $${(depositAmount / 100).toFixed(2)} deposit has been received. Your appointment is secured!</p>
            </div>
            ` : ''}
            
            <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
              <p style="margin: 0; color: #856404;"><strong>📋 What to Expect</strong></p>
              <p style="margin: 5px 0 0 0; color: #856404;">We'll contact you before your appointment to confirm details and answer any questions.</p>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <p style="color: #0a0f1a; font-weight: bold;">Questions or need to reschedule?</p>
              <p style="margin: 10px 0;">
                <a href="tel:4423423627" style="color: #FFD700; text-decoration: none; font-weight: bold;">📞 (442) 342-3627</a>
              </p>
            </div>
          </div>
          
          <div style="background: #0a0f1a; color: #fff; padding: 20px; text-align: center; font-size: 12px;">
            <p style="margin: 0; font-weight: bold;">Flawless Finish Ceramic Coating</p>
            <p style="margin: 5px 0 0 0;">Palm Springs & Coachella Valley</p>
            <p style="margin: 5px 0 0 0;">Owner: Jason (Jay)</p>
          </div>
        </div>
      `
    };
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Email send timeout after 10 seconds')), 10000);
    });
    
    const info = await Promise.race([
      transporter.sendMail(mailOptions),
      timeoutPromise
    ]);
    
    console.log('✅ Customer confirmation email sent successfully to:', customerEmail);
    console.log('Email message ID:', info.messageId);
  } catch (err) {
    console.error('❌ Customer confirmation email error:', err?.message || err);
    console.error('Error stack:', err?.stack);
    // Don't block booking - email failure shouldn't prevent booking completion
  }
}

async function sendEmailNotification(bookingData) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('Email skipped – Email credentials missing.');
    return;
  }
  
  try {
    const { customerName, customerPhone, customerEmail, selectedDate, vehicleInfo, depositAmount, serviceLevel, paymentMethod } = bookingData;
    
    console.log('Sending booking notification email to:', recipientEmails.join(', '));
    console.log('Customer info:', { name: customerName, phone: customerPhone, date: selectedDate, vehicle: vehicleInfo, service: serviceLevel, paymentMethod });
    
    const mailOptions = {
      from: `"Flawless Finish Website" <${process.env.EMAIL_USER}>`,
      to: recipientEmails.join(', '), // Support multiple recipients
      subject: `New ${depositAmount > 0 ? 'Paid' : 'Cash'} Booking - ${customerName} - ${selectedDate}`,
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
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Vehicle Type:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(vehicleInfo || 'Not specified')}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Service:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${escapeHtml(serviceLevel || 'Not specified')}</td>
              </tr>
              ${depositAmount > 0 ? `
              <tr>
                <td style="padding: 10px; font-weight: bold;">Deposit:</td>
                <td style="padding: 10px; color: #FFD700; font-weight: bold;">$${(depositAmount / 100).toFixed(2)}</td>
              </tr>
              ` : ''}
              <tr>
                <td style="padding: 10px; font-weight: bold;">Payment Method:</td>
                <td style="padding: 10px; font-weight: bold;">${escapeHtml(paymentMethod || 'Cash Reservation')}</td>
              </tr>
            </table>

            ${depositAmount > 0 ? `
            <div style="margin-top: 30px; padding: 20px; background: #e8f5e8; border-left: 4px solid #4CAF50;">
              <h4 style="margin: 0 0 10px 0; color: #2e7d32;">✅ Deposit Received</h4>
              <p style="margin: 0; color: #2e7d32;">The customer has successfully paid the $${(depositAmount / 100).toFixed(2)} deposit to secure their booking.</p>
            </div>
            ` : `
            <div style="margin-top: 30px; padding: 20px; background: #fff3cd; border-left: 4px solid #ffc107;">
              <h4 style="margin: 0 0 10px 0; color: #856404;">💰 Cash Reservation</h4>
              <p style="margin: 0; color: #856404;">This is a cash reservation. No deposit has been paid. Please contact the customer to confirm the appointment.</p>
            </div>
            `}

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
    
    console.log('✅ Admin notification email sent successfully to:', recipientEmails.join(', '));
    console.log('Email message ID:', info.messageId);
  } catch (err) {
    console.error('❌ Admin notification email error:', err?.message || err);
    console.error('Error stack:', err?.stack);
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
    const displayDate = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    out.push({ date: ymd, booked, displayDate });
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

    const { paymentIntentId, date, name, phone, email, vehicleType, serviceLevel } = req.body || {};
    
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
    const sanitizedEmail = String(email || '').trim().slice(0, 100);
    const vehicleInfo = vehicleType ? String(vehicleType).charAt(0).toUpperCase() + String(vehicleType).slice(1) : 'Not specified';

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

    // Format date for emails
    const humanDate = new Date(sanitizedDate + 'T12:00:00').toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', timeZone: 'America/Los_Angeles' });
    const bookingData = {
      customerName: sanitizedName || 'N/A',
      customerPhone: sanitizedPhone || 'N/A',
      customerEmail: sanitizedEmail || 'Not provided',
      selectedDate: humanDate,
      vehicleInfo: vehicleInfo,
      serviceLevel: serviceLevel || 'Not specified',
      depositAmount: 25000,
      paymentMethod: 'Stripe Card',
      stripePaymentId: paymentIntentId
    };

    // Send admin notification email
    await sendEmailNotification(bookingData);
    
    // Send customer confirmation email
    await sendCustomerConfirmationEmail(bookingData);

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
  let { date, name, phone, email, vehicleType, serviceLevel } = req.body || {};
  if (!date) return res.status(400).json({ success: false, message: 'Please select a date.' });
  if (!name || name.trim().length === 0) return res.status(400).json({ success: false, message: 'Please enter your name.' });
  if (!phone || phone.trim().length === 0) return res.status(400).json({ success: false, message: 'Please enter your phone number.' });

  // sanitize input
  const sanitizedDate = String(date).slice(0, 10); // YYYY-MM-DD
  const sanitizedName = typeof name === 'string' ? name.slice(0, 80) : '';
  const sanitizedPhone = typeof phone === 'string' ? phone.slice(0, 40) : '';
  const sanitizedEmail = typeof email === 'string' ? email.trim().slice(0, 100) : '';
  const vehicleInfo = vehicleType ? String(vehicleType).charAt(0).toUpperCase() + String(vehicleType).slice(1) : 'Not specified';

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

  // Format date for emails
  const humanDate = new Date(sanitizedDate + 'T12:00:00').toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', timeZone: 'America/Los_Angeles' });
  const bookingData = {
    customerName: sanitizedName || 'N/A',
    customerPhone: sanitizedPhone || 'N/A',
    customerEmail: sanitizedEmail || 'Not provided',
    selectedDate: humanDate,
    vehicleInfo: vehicleInfo,
    serviceLevel: serviceLevel || 'Not specified',
    depositAmount: 0,
    paymentMethod: 'Cash Reservation',
    stripePaymentId: 'N/A'
  };

  // Send admin notification email
  console.log('Attempting to send emails for cash booking...');
  try {
    await sendEmailNotification(bookingData);
    console.log('Admin notification email attempt completed');
  } catch (emailErr) {
    console.error('Error sending admin notification email:', emailErr);
  }
  
  // Send customer confirmation email
  try {
    await sendCustomerConfirmationEmail(bookingData);
    console.log('Customer confirmation email attempt completed');
  } catch (emailErr) {
    console.error('Error sending customer confirmation email:', emailErr);
  }

  return res.json({ success: true, message: 'Cash reservation saved.', date: sanitizedDate, method: 'cash' });
});

// ── API: get Stripe publishable key ───────────────────────────────────────────
app.get('/api/stripe-key', (_, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flawless Finish server running on ${PORT}`));
