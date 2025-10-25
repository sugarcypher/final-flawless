// server-local.js — Local development server without external dependencies
const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors({ origin: true }));
app.disable('x-powered-by');

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('.'));

// Mock booking data for local development
const bookingsFile = path.join(__dirname, 'bookings.json');

function getBookings() {
  try {
    if (fs.existsSync(bookingsFile)) {
      const data = fs.readFileSync(bookingsFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading bookings:', error);
  }
  return [];
}

function saveBookings(bookings) {
  try {
    fs.writeFileSync(bookingsFile, JSON.stringify(bookings, null, 2));
  } catch (error) {
    console.error('Error saving bookings:', error);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get availability (mock data for local development)
app.get('/api/availability', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const bookings = getBookings();
  const bookedDates = new Set(bookings.map(booking => booking.date));
  
  const availableDates = [];
  const today = new Date();
  
  for (let i = 1; i <= days; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    
    if (!bookedDates.has(dateStr)) {
      availableDates.push(dateStr);
    }
  }
  
  res.json({ available: availableDates });
});

// Mock payment endpoints for local development
app.post('/api/create-payment-intent', (req, res) => {
  console.log('Mock payment intent created for local development');
  res.json({
    success: true,
    clientSecret: 'mock_client_secret_for_local_dev',
    paymentIntentId: 'mock_payment_intent_id'
  });
});

app.post('/api/confirm-payment', (req, res) => {
  const { date, name, phone } = req.body;
  console.log('Mock payment confirmed for local development:', { date, name, phone });
  
  const bookings = getBookings();
  bookings.push({
    id: Date.now(),
    date,
    name,
    phone,
    paymentMethod: 'card',
    amount: 250,
    status: 'confirmed',
    createdAt: new Date().toISOString()
  });
  saveBookings(bookings);
  
  res.json({ success: true, message: 'Mock booking created successfully' });
});

app.post('/api/book-cash', (req, res) => {
  const { date, name, phone } = req.body;
  console.log('Mock cash booking created for local development:', { date, name, phone });
  
  const bookings = getBookings();
  bookings.push({
    id: Date.now(),
    date,
    name,
    phone,
    paymentMethod: 'cash',
    amount: 0,
    status: 'confirmed',
    createdAt: new Date().toISOString()
  });
  saveBookings(bookings);
  
  res.json({ success: true, message: 'Mock cash booking created successfully' });
});

app.get('/api/stripe-key', (req, res) => {
  res.json({ publishableKey: 'pk_test_mock_key_for_local_development' });
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Flawless Finish Ceramic Coating - Local Development Server`);
  console.log(`📍 Running at: http://localhost:${PORT}`);
  console.log(`🔧 Mode: Local Development (Mock APIs)`);
  console.log(`📱 Test the website in your browser!`);
});

module.exports = app;
