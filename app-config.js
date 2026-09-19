/**
 * Coco Rush — public runtime configuration.
 * ---------------------------------------------------------------------------
 * Only values that are SAFE TO EXPOSE IN A BROWSER belong in this file.
 * Firebase web config and the Razorpay *key id* are public by design.
 *
 * NEVER put these here — keep them in the server environment (.env):
 *   - RAZORPAY_KEY_SECRET
 *   - FIREBASE_SERVICE_ACCOUNT
 *
 * Keeping configuration in its own file means the storefront markup holds no
 * keys and behaviour can be repointed per environment without touching logic.
 */
window.COCORUSH_CONFIG = {
  // Base path for the serverless API in /api
  apiBase: '/api',

  // Razorpay public key id (rzp_live_… / rzp_test_…). Safe in the browser.
  razorpayKeyId: 'REPLACE_WITH_RAZORPAY_KEY_ID',

  // Firebase Console → Project Settings → General → Your apps → Web app → Config
  firebase: {
    apiKey: 'REPLACE_WITH_FIREBASE_API_KEY',
    authDomain: 'REPLACE_WITH_PROJECT.firebaseapp.com',
    databaseURL: 'https://REPLACE_WITH_PROJECT-default-rtdb.firebaseio.com',
    projectId: 'REPLACE_WITH_PROJECT_ID',
    storageBucket: 'REPLACE_WITH_PROJECT.appspot.com',
    messagingSenderId: 'REPLACE_WITH_MESSAGING_SENDER_ID',
    appId: 'REPLACE_WITH_APP_ID'
  },

  store: {
    name: 'Coco Rush',
    phone: '+919395860844',
    email: 'support@cocorush.com',
    currency: 'INR',
    // Domain used to turn a bare phone number into a Firebase Auth identity.
    phoneAuthDomain: 'phone.cocorush.app',

    // Shipping rules applied when the server prices an order.
    shipping: { flat: 0, freeAbove: 0 }
  }
};
