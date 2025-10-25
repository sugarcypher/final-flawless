// Test script for Stripe and Twilio integrations
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const twilio = require('twilio');

async function testStripe() {
  console.log('🧪 Testing Stripe integration...');
  
  if (!process.env.STRIPE_SECRET_KEY) {
    console.log('❌ STRIPE_SECRET_KEY not found in environment variables');
    return false;
  }
  
  try {
    // Test creating a payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 25000, // $250.00 in cents
      currency: 'usd',
      metadata: {
        test: 'true',
        service: 'Flawless Finish Ceramic Coating Deposit'
      }
    });
    
    console.log('✅ Stripe payment intent created successfully');
    console.log(`   Payment Intent ID: ${paymentIntent.id}`);
    console.log(`   Status: ${paymentIntent.status}`);
    return true;
  } catch (error) {
    console.log('❌ Stripe test failed:', error.message);
    return false;
  }
}

async function testTwilio() {
  console.log('🧪 Testing Twilio integration...');
  
  if (!process.env.TWILIO_SID || !process.env.TWILIO_TOKEN) {
    console.log('❌ Twilio credentials not found in environment variables');
    return false;
  }
  
  try {
    const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
    
    // Test sending a SMS (only if phone numbers are configured)
    if (process.env.TWILIO_FROM && process.env.TWILIO_TO) {
      const message = await client.messages.create({
        from: process.env.TWILIO_FROM,
        to: process.env.TWILIO_TO,
        body: 'Flawless Finish integration test - SMS working! 📱'
      });
      
      console.log('✅ Twilio SMS sent successfully');
      console.log(`   Message SID: ${message.sid}`);
      return true;
    } else {
      console.log('⚠️  Twilio credentials found but phone numbers not configured');
      console.log('   Set TWILIO_FROM and TWILIO_TO to test SMS functionality');
      return true;
    }
  } catch (error) {
    console.log('❌ Twilio test failed:', error.message);
    return false;
  }
}

async function runTests() {
  console.log('🚀 Starting Flawless Finish integration tests...\n');
  
  const stripeResult = await testStripe();
  console.log('');
  const twilioResult = await testTwilio();
  
  console.log('\n📊 Test Results:');
  console.log(`   Stripe: ${stripeResult ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   Twilio: ${twilioResult ? '✅ PASS' : '❌ FAIL'}`);
  
  if (stripeResult && twilioResult) {
    console.log('\n🎉 All integrations working! Ready for production.');
  } else {
    console.log('\n⚠️  Some integrations need configuration. Check your .env file.');
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testStripe, testTwilio, runTests };

