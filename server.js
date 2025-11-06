// server.js — Improved v6 with better API structure and validation
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

// Enhanced security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "https://js.stripe.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://api.stripe.com"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

app.use(compression());
app.use(cors({ origin: true }));
app.disable('x-powered-by');

// Enhanced rate limiting
const limiter = rateLimit({ 
  windowMs: 15 * 60 * 1000, 
  max: 200,
  message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Enhanced body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

// ── Enhanced Helpers ───────────────────────────────────────────────────────────
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

// Enhanced validation helpers
function validatePhone(phone) {
  const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
  return phoneRegex.test(phone.replace(/[\s\-\(\)]/g, ''));
}

function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function sanitizeInput(input, maxLength = 100) {
  return String(input || '').slice(0, maxLength).trim();
}

// ── Enhanced Email Configuration ───────────────────────────────────────────────
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
const jasonEmail = 'chaddGeePeeTee@gmail.com';

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

// ── Enhanced API Endpoints ─────────────────────────────────────────────────────

// GET Stripe publishable key
app.get('/api/stripe-key', (req, res) => {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  res.json({ publishableKey });
});

// GET availability with enhanced validation
app.get('/api/availability', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30', 10), 90); // Max 90 days
    const bookings = readBookings();
    const now = new Date();
    now.setHours(0,0,0,0);

    const out = [];
    for (let i = 1; i <= days; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      const dow = d.getDay(); // 0 Sun .. 6 Sat
      if (dow === 0) continue; // closed Sundays

      const ymd = toYMD(d);
      const booked = bookings.some(b => b.date === ymd);
      out.push({ 
        date: ymd, 
        booked,
        dayOfWeek: d.toLocaleDateString('en-US', { weekday: 'short' }),
        displayDate: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      });
    }
    res.json({ success: true, days: out });
  } catch (error) {
    console.error('Availability error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch availability' });
  }
});

// POST create payment intent with enhanced validation
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ 
        success: false, 
        message: 'Payment system temporarily unavailable. Please contact us directly.' 
      });
    }

    const { date, name, phone, email } = req.body || {};
    
    // Enhanced validation
    if (!date) return res.status(400).json({ success: false, message: 'Please select a date.' });
    if (!name || name.trim().length < 2) return res.status(400).json({ success: false, message: 'Please enter a valid name (minimum 2 characters).' });
    if (!phone || !validatePhone(phone)) return res.status(400).json({ success: false, message: 'Please enter a valid phone number.' });
    if (email && !validateEmail(email)) return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });

    // Check if date is already booked
    const bookings = readBookings();
    const sanitizedDate = toYMD(date);
    if (bookings.some(b => b.date === sanitizedDate)) {
      return res.status(409).json({ success: false, message: 'That day is already booked.' });
    }

    // Create Stripe payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 25000, // $250.00 in cents
      currency: 'usd',
      metadata: {
        date: sanitizedDate,
        name: sanitizeInput(name, 80),
        phone: sanitizeInput(phone, 40),
        email: sanitizeInput(email, 100),
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

// POST confirm payment with enhanced validation
app.post('/api/confirm-payment', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ 
        success: false, 
        message: 'Payment system temporarily unavailable. Please contact us directly.' 
      });
    }

    const { paymentIntentId, date, name, phone, email } = req.body || {};
    
    if (!paymentIntentId || !date) {
      return res.status(400).json({ success: false, message: 'Missing payment or date information.' });
    }

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ success: false, message: 'Payment not completed.' });
    }

    // Sanitize input
    const sanitizedDate = toYMD(date);
    const sanitizedName = sanitizeInput(name, 80);
    const sanitizedPhone = sanitizeInput(phone, 40);
    const sanitizedEmail = sanitizeInput(email, 100);

    const bookings = readBookings();
    if (bookings.some(b => b.date === sanitizedDate)) {
      return res.status(409).json({ success: false, message: 'That day is already booked.' });
    }

    // Save booking with payment confirmation
    bookings.push({ 
      date: sanitizedDate, 
      name: sanitizedName, 
      phone: sanitizedPhone,
      email: sanitizedEmail,
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

// POST book cash with enhanced validation
app.post('/api/book-cash', async (req, res) => {
  try {
    const { date, name, phone, email } = req.body || {};
    
    // Enhanced validation
    if (!date) return res.status(400).json({ success: false, message: 'Please select a date.' });
    if (!name || name.trim().length < 2) return res.status(400).json({ success: false, message: 'Please enter a valid name (minimum 2 characters).' });
    if (!phone || !validatePhone(phone)) return res.status(400).json({ success: false, message: 'Please enter a valid phone number.' });
    if (email && !validateEmail(email)) return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });

    // Sanitize input
    const sanitizedDate = toYMD(date);
    const sanitizedName = sanitizeInput(name, 80);
    const sanitizedPhone = sanitizeInput(phone, 40);
    const sanitizedEmail = sanitizeInput(email, 100);

    const bookings = readBookings();
    if (bookings.some(b => b.date === sanitizedDate)) {
      return res.status(409).json({ success: false, message: 'That day is already booked.' });
    }

    // Save cash booking
    bookings.push({ 
      date: sanitizedDate, 
      name: sanitizedName, 
      phone: sanitizedPhone,
      email: sanitizedEmail,
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
      customerEmail: sanitizedEmail || 'Not provided',
      selectedDate: humanDate,
      vehicleInfo: 'Not specified',
      depositAmount: 0,
      paymentMethod: 'Cash Reservation',
      stripePaymentId: 'N/A'
    });

    return res.json({ success: true, message: 'Cash reservation saved.', date: sanitizedDate, method: 'cash' });
  } catch (error) {
    console.error('Cash booking error:', error);
    res.status(500).json({ success: false, message: 'Cash booking failed.' });
  }
});

// POST submit review with enhanced validation
app.post('/api/submit-review', async (req, res) => {
  try {
    const { name, location, review, rating } = req.body || {};
    
    if (!name || !location || !review || !rating) {
      return res.status(400).json({ 
        success: false, 
        message: 'All fields are required' 
      });
    }

    // Enhanced validation
    if (name.trim().length < 2) {
      return res.status(400).json({ 
        success: false, 
        message: 'Name must be at least 2 characters' 
      });
    }

    if (review.trim().length < 10) {
      return res.status(400).json({ 
        success: false, 
        message: 'Review must be at least 10 characters' 
      });
    }

    // Validate rating
    const ratingNum = parseInt(rating);
    if (ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ 
        success: false, 
        message: 'Rating must be between 1 and 5' 
      });
    }

    // Store review (in production, use a database)
    const reviewsFile = path.join(__dirname, 'reviews.json');
    let reviews = [];
    try {
      if (fs.existsSync(reviewsFile)) {
        reviews = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
      }
    } catch {}

    reviews.push({
      name: sanitizeInput(name, 80),
      location: sanitizeInput(location, 80),
      review: sanitizeInput(review, 500),
      rating: ratingNum,
      createdAt: new Date().toISOString()
    });

    fs.writeFileSync(reviewsFile, JSON.stringify(reviews, null, 2));

    res.json({ 
      success: true, 
      message: 'Review submitted successfully' 
    });
  } catch (error) {
    console.error('Review submission error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to submit review' 
    });
  }
});

// GET reviews
app.get('/api/reviews', (req, res) => {
  try {
    const reviewsFile = path.join(__dirname, 'reviews.json');
    let reviews = [];
    
    if (fs.existsSync(reviewsFile)) {
      reviews = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'));
    }

    // Return most recent reviews first
    reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ 
      success: true, 
      reviews: reviews.slice(0, 10) // Limit to 10 most recent
    });
  } catch (error) {
    console.error('Get reviews error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch reviews' 
    });
  }
});

// POST email signup with enhanced validation
app.post('/api/email-signup', async (req, res) => {
  try {
    const { email } = req.body || {};
    
    if (!email || !validateEmail(email)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Valid email address is required' 
      });
    }

    // Store email signup (in production, use a database)
    const signupsFile = path.join(__dirname, 'email-signups.json');
    let signups = [];
    try {
      if (fs.existsSync(signupsFile)) {
        signups = JSON.parse(fs.readFileSync(signupsFile, 'utf8'));
      }
    } catch {}

    const normalizedEmail = email.toLowerCase().trim();
    
    // Check if email already exists
    if (signups.some(s => s.email === normalizedEmail)) {
      return res.status(409).json({ 
        success: false, 
        message: 'Email already subscribed' 
      });
    }

    signups.push({
      email: normalizedEmail,
      createdAt: new Date().toISOString()
    });

    fs.writeFileSync(signupsFile, JSON.stringify(signups, null, 2));

    res.json({ 
      success: true, 
      message: 'Successfully subscribed to updates' 
    });
  } catch (error) {
    console.error('Email signup error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to subscribe' 
    });
  }
});

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flawless Finish server running on ${PORT}`));