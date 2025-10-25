// server.js — v5 Stripe + Email integration
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
// Initialize Stripe with fallback for missing keys
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

const app = express();

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors({ origin: true }));
app.disable('x-powered-by');

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(limiter);

app.use(express.json());
app.use(express.static(__dirname, { extensions: ['html'] }));

const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

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

// ── Email Configuration ─────────────────────────────────────────────────────────
const emailConfig = {
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
};

const transporter = nodemailer.createTransport(emailConfig);
const jasonEmail = 'j@flawlessfini.sh';

async function sendEmailNotification(bookingData) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('Email skipped – Email credentials missing.');
    return;
  }
  
  try {
    const { customerName, customerPhone, customerEmail, selectedDate, vehicleInfo, depositAmount } = bookingData;
    
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
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${customerName}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Phone:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${customerPhone}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Email:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${customerEmail}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Date:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${selectedDate}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">Vehicle:</td>
                <td style="padding: 10px; border-bottom: 1px solid #ddd;">${vehicleInfo || 'Not specified'}</td>
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
              <a href="tel:${customerPhone}" style="background: #FFD700; color: #0a0f1a; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
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

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
  } catch (err) {
    console.error('Email error:', err?.message || err);
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
        date: String(date).slice(0, 10),
        name: String(name || '').slice(0, 80),
        phone: String(phone || '').slice(0, 40),
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

    const { paymentIntentId, date, name, phone } = req.body || {};
    
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

    const bookings = readBookings();
    if (bookings.some(b => b.date === sanitizedDate)) {
      return res.status(409).json({ success: false, message: 'That day is already booked.' });
    }

    // Save booking with payment confirmation
    bookings.push({ 
      date: sanitizedDate, 
      name: sanitizedName, 
      phone: sanitizedPhone, 
      method: 'card', 
      deposit: 250,
      stripePaymentId: paymentIntentId,
      createdAt: new Date().toISOString() 
    });
    writeBookings(bookings);

    // Notify Jason by email
    const humanDate = new Date(sanitizedDate + 'T12:00:00').toLocaleDateString([], { weekday:'short', month:'short', day:'numeric', timeZone: 'America/Los_Angeles' });
    await sendEmailNotification({
      customerName: sanitizedName || 'N/A',
      customerPhone: sanitizedPhone || 'N/A',
      customerEmail: sanitizedEmail || 'Not provided',
      selectedDate: humanDate,
      vehicleInfo: 'Not specified',
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
  let { date, name, phone } = req.body || {};
  if (!date) return res.status(400).json({ success: false, message: 'Please select a date.' });
  if (!name || name.trim().length === 0) return res.status(400).json({ success: false, message: 'Please enter your name.' });
  if (!phone || phone.trim().length === 0) return res.status(400).json({ success: false, message: 'Please enter your phone number.' });

  // sanitize input
  const sanitizedDate = String(date).slice(0, 10); // YYYY-MM-DD
  const sanitizedName = typeof name === 'string' ? name.slice(0, 80) : '';
  const sanitizedPhone = typeof phone === 'string' ? phone.slice(0, 40) : '';

  const bookings = readBookings();
  if (bookings.some(b => b.date === sanitizedDate)) {
    return res.status(409).json({ success: false, message: 'That day is already booked.' });
  }

  // Save cash booking
  bookings.push({ 
    date: sanitizedDate, 
    name: sanitizedName, 
    phone: sanitizedPhone, 
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
    vehicleInfo: 'Not specified',
    depositAmount: 0,
    paymentMethod: 'Cash Reservation',
    stripePaymentId: 'N/A'
  });

  return res.json({ success: true, message: 'Cash reservation saved.', date: sanitizedDate, method: 'cash' });
});

// ── API: get Stripe publishable key ───────────────────────────────────────────
app.get('/api/stripe-key', (_, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flawless Finish server running on ${PORT}`));
