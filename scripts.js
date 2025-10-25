// scripts.js — v5 Stripe integration + cash/card options
const calEl = document.getElementById('calendar');
const nextSlotEl = document.getElementById('nextSlot');
const depositBtn = document.getElementById('depositBtn');
let selectedDate = null;
let stripe = null;
let elements = null;
let paymentElement = null;

function fmtDay(ymd){
  const d = new Date(ymd + 'T12:00:00');
  return d.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' });
}

async function loadCalendar(){
  calEl.innerHTML = '<div class="notice">Loading days…</div>';
  const res = await fetch('/api/availability?days=30');
  const data = await res.json();
  calEl.innerHTML = '';

  // Build a simple 6x5-ish grid of days
  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(6, 1fr)';
  grid.style.gap = '8px';

  let firstOpen = null;
  data.days.forEach(day => {
    const cell = document.createElement('button');
    cell.className = 'slot';
    cell.style.padding = '12px';
    cell.textContent = fmtDay(day.date);
    cell.disabled = day.booked;
    if (day.booked) {
      cell.classList.add('taken');
      cell.title = 'Booked';
    }
    cell.addEventListener('click', () => {
      selectedDate = day.date;
      document.querySelectorAll('.slot').forEach(n=>n.classList.remove('selected'));
      cell.classList.add('selected');
      // enable action buttons below (we’ll render them if not present)
      renderActions();
    });
    if (!day.booked && !firstOpen) firstOpen = day.date;
    grid.appendChild(cell);
  });

  calEl.appendChild(grid);
  nextSlotEl.textContent = firstOpen
    ? 'Next available: ' + fmtDay(firstOpen)
    : 'No available days in the next 30 days.';
}

function ensureActionRow(){
  let row = document.getElementById('actionRow');
  if (row) return row;
  row = document.createElement('div');
  row.id = 'actionRow';
  row.className = 'cta-row';
  row.style.marginTop = '12px';
  calEl.parentElement.appendChild(row);
  return row;
}

function renderActions(){
  const row = ensureActionRow();
  row.innerHTML = '';

  // Cash reservation button
  const cashBtn = document.createElement('button');
  cashBtn.className = 'button secondary';
  cashBtn.textContent = 'Reserve with Cash';
  cashBtn.disabled = !selectedDate;
  cashBtn.onclick = () => bookCash();

  // Card payment section
  const cardSection = document.createElement('div');
  cardSection.style.marginTop = '12px';
  
  // Create payment form container
  const paymentForm = document.createElement('form');
  paymentForm.id = 'payment-form';
  paymentForm.style.marginTop = '12px';
  
  // Payment element container
  const paymentElementContainer = document.createElement('div');
  paymentElementContainer.id = 'payment-element';
  paymentElementContainer.style.marginBottom = '12px';
  
  // Pay button
  const payBtn = document.createElement('button');
  payBtn.id = 'submit-payment';
  payBtn.className = 'button primary';
  payBtn.textContent = 'Pay $250 Deposit';
  payBtn.disabled = !selectedDate;
  payBtn.style.width = '100%';
  
  // Error display
  const errorElement = document.createElement('div');
  errorElement.id = 'payment-message';
  errorElement.style.color = '#dc2626';
  errorElement.style.fontSize = '14px';
  errorElement.style.marginTop = '8px';
  
  paymentForm.appendChild(paymentElementContainer);
  paymentForm.appendChild(payBtn);
  paymentForm.appendChild(errorElement);
  
  cardSection.appendChild(paymentForm);
  
  row.appendChild(cashBtn);
  row.appendChild(cardSection);
  
  // Initialize Stripe if date is selected
  if (selectedDate) {
    initializeStripePayment();
  }
}

// Initialize Stripe payment
async function initializeStripePayment() {
  // Load Stripe.js if not already loaded
  if (!window.Stripe) {
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.onload = () => setupStripe();
    document.head.appendChild(script);
  } else {
    setupStripe();
  }
}

async function setupStripe() {
  try {
    // Get Stripe publishable key
    const keyResponse = await fetch('/api/stripe-key');
    const { publishableKey } = await keyResponse.json();
    
    if (!publishableKey) {
      throw new Error('Stripe not configured');
    }
    
    // Get customer info
    const name = prompt('Your name (required):') || '';
    const phone = prompt('Your phone number (required):') || '';
    
    if (!name.trim()) {
      showToast('Please enter your name to continue.', 'error');
      return;
    }
    if (!phone.trim()) {
      showToast('Please enter your phone number to continue.', 'error');
      return;
    }
    
    // Create payment intent
    const response = await fetch('/api/create-payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: selectedDate, name, phone })
    });
    
    const { clientSecret, success } = await response.json();
    
    if (!success) {
      throw new Error('Failed to create payment intent');
    }
    
    // Initialize Stripe
    stripe = Stripe(publishableKey);
    elements = stripe.elements({ clientSecret });
    
    // Create payment element
    paymentElement = elements.create('payment');
    paymentElement.mount('#payment-element');
    
    // Handle form submission
    const form = document.getElementById('payment-form');
    form.addEventListener('submit', handlePaymentSubmit);
    
  } catch (error) {
    console.error('Stripe setup error:', error);
    showPaymentError('Failed to initialize payment. Please try again or contact Jason directly.');
  }
}

async function handlePaymentSubmit(event) {
  event.preventDefault();
  
  const submitBtn = document.getElementById('submit-payment');
  const name = prompt('Your name (required):') || '';
  const phone = prompt('Your phone number (required):') || '';
  
  if (!name.trim()) {
    showToast('Please enter your name to continue.', 'error');
    return;
  }
  if (!phone.trim()) {
    showToast('Please enter your phone number to continue.', 'error');
    return;
  }
  
  submitBtn.disabled = true;
  submitBtn.textContent = 'Processing...';
  
  try {
    // Confirm payment
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.href,
      },
    });
    
    if (error) {
      showPaymentError(error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Pay $250 Deposit';
      return;
    }
    
    // Get payment intent ID from the URL or from the confirmed payment
    const urlParams = new URLSearchParams(window.location.search);
    const paymentIntentId = urlParams.get('payment_intent');
    
    if (!paymentIntentId) {
      throw new Error('Payment intent not found');
    }
    
    // Confirm booking
    const response = await fetch('/api/confirm-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        paymentIntentId, 
        date: selectedDate, 
        name, 
        phone 
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      showPaymentSuccess(`Booking confirmed for ${fmtDay(selectedDate)}! Jason has been notified.`);
      selectedDate = null;
      await loadCalendar();
      renderActions();
    } else {
      showPaymentError(result.message || 'Booking failed. Please contact Jason directly.');
    }
    
  } catch (error) {
    console.error('Payment error:', error);
    showPaymentError('Payment failed. Please try again or contact Jason directly.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Pay $250 Deposit';
  }
}

async function bookCash() {
  if (!selectedDate) return;
  const name = prompt('Your name (required):') || '';
  const phone = prompt('Your phone number (required):') || '';
  
  if (!name.trim()) {
    showToast('Please enter your name to continue.', 'error');
    return;
  }
  if (!phone.trim()) {
    showToast('Please enter your phone number to continue.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/book-cash', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ date: selectedDate, name, phone })
    });
    const out = await res.json();
    if (out.success) {
      alert(`Cash reservation confirmed for ${fmtDay(selectedDate)}. Jason has been notified.`);
      selectedDate = null;
      await loadCalendar();
      renderActions();
    } else {
      alert(out.message || 'Could not book.');
    }
  } catch {
    alert('Network error.');
  }
}

function showPaymentError(message) {
  const errorElement = document.getElementById('payment-message');
  if (errorElement) {
    errorElement.textContent = message;
    errorElement.style.display = 'block';
  }
}

function showPaymentSuccess(message) {
  const errorElement = document.getElementById('payment-message');
  if (errorElement) {
    errorElement.textContent = message;
    errorElement.style.color = '#059669';
    errorElement.style.display = 'block';
  }
}

// Gallery lightbox functionality
function initGallery() {
  const galleryItems = document.querySelectorAll('.gallery-item');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxCaption = document.getElementById('lightbox-caption');
  
  galleryItems.forEach(item => {
    item.addEventListener('click', () => {
      const img = item.querySelector('img');
      const caption = item.querySelector('.gallery-caption');
      
      lightboxImg.src = img.src;
      lightboxImg.alt = img.alt;
      lightboxCaption.textContent = caption.textContent;
      lightbox.classList.add('active');
      document.body.style.overflow = 'hidden';
    });
  });
  
  // Close lightbox when clicking on it
  lightbox.addEventListener('click', () => {
    lightbox.classList.remove('active');
    document.body.style.overflow = 'auto';
  });
  
  // Close lightbox with Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox.classList.contains('active')) {
      lightbox.classList.remove('active');
      document.body.style.overflow = 'auto';
    }
  });
}

// Reviews functionality
function initReviews() {
  const reviewForm = document.getElementById('reviewForm');
  const reviewsList = document.getElementById('recentReviews');
  
  // Load existing reviews from localStorage
  loadReviews();
  
  // Handle review form submission
  reviewForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const formData = new FormData(reviewForm);
    const review = {
      id: Date.now(),
      name: formData.get('name'),
      location: formData.get('location'),
      review: formData.get('review'),
      rating: formData.get('rating'),
      date: new Date().toLocaleDateString()
    };
    
    // Save to localStorage
    const reviews = JSON.parse(localStorage.getItem('reviews') || '[]');
    reviews.unshift(review);
    localStorage.setItem('reviews', JSON.stringify(reviews));
    
    // Add to display
    addReviewToDisplay(review);
    
    // Reset form
    reviewForm.reset();
    
    // Show success message
    showNotification('Thank you for your review!', 'success');
  });
  
  function loadReviews() {
    const reviews = JSON.parse(localStorage.getItem('reviews') || '[]');
    reviews.forEach(review => addReviewToDisplay(review));
  }
  
  function addReviewToDisplay(review) {
    const reviewItem = document.createElement('div');
    reviewItem.className = 'review-item';
    reviewItem.innerHTML = `
      <div class="review-header">
        <div>
          <div class="reviewer">${review.name}</div>
          <div class="review-location">${review.location}</div>
        </div>
        <div class="review-rating">${'⭐'.repeat(review.rating)}</div>
      </div>
      <div class="review-text">${review.review}</div>
    `;
    reviewsList.appendChild(reviewItem);
  }
}

// Email signup functionality
function initEmailSignup() {
  const emailForm = document.getElementById('emailSignup');
  
  emailForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const formData = new FormData(emailForm);
    const email = formData.get('email');
    
    // Save to localStorage (in a real app, this would go to a server)
    const subscribers = JSON.parse(localStorage.getItem('subscribers') || '[]');
    if (!subscribers.includes(email)) {
      subscribers.push(email);
      localStorage.setItem('subscribers', JSON.stringify(subscribers));
      showNotification('Successfully subscribed! Check your email for confirmation.', 'success');
    } else {
      showNotification('You\'re already subscribed!', 'info');
    }
    
    emailForm.reset();
  });
}

// Notification system
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  
  // Add styles
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : '#2196F3'};
    color: white;
    padding: 16px 24px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10000;
    animation: slideIn 0.3s ease;
  `;
  
  document.body.appendChild(notification);
  
  // Remove after 3 seconds
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Add CSS for notifications
const notificationStyles = document.createElement('style');
notificationStyles.textContent = `
  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  @keyframes slideOut {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }
`;
document.head.appendChild(notificationStyles);

loadCalendar();
initGallery();
initReviews();
initEmailSignup();
