// Test script for Stripe integration
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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

async function testEmail() {
  console.log('🧪 Testing Email configuration...');
  
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('❌ Email credentials not found in environment variables');
    console.log('   Set EMAIL_USER and EMAIL_PASS to enable email notifications');
    return false;
  }
  
  console.log('✅ Email credentials found');
  console.log(`   Email: ${process.env.EMAIL_USER}`);
  return true;
}

async function runTests() {
  console.log('🚀 Starting Flawless Finish integration tests...\n');
  
  const stripeResult = await testStripe();
  console.log('');
  const emailResult = await testEmail();
  
  console.log('\n📊 Test Results:');
  console.log(`   Stripe: ${stripeResult ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   Email: ${emailResult ? '✅ PASS' : '❌ FAIL'}`);
  
  if (stripeResult && emailResult) {
    console.log('\n🎉 All integrations working! Ready for production.');
  } else {
    console.log('\n⚠️  Some integrations need configuration. Check your .env file.');
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testStripe, testEmail, runTests };