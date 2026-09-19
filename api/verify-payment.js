/**
 * POST /api/verify-payment
 * ---------------------------------------------------------------------------
 * Called from the Razorpay checkout handler after a successful payment.
 *   1. Recompute the HMAC signature — an unsigned request is treated as hostile.
 *   2. Look the order up by Razorpay order id.
 *   3. Idempotently mark it paid and move stock exactly once.
 *
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * Env:  FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL, RAZORPAY_KEY_SECRET
 */
const crypto = require('crypto');
const { getDb, applyStockDelta } = require('./_firebase');

const readBody = (req) => {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (err) { return {}; }
};

/** Constant-time compare so signature checks cannot be timed. */
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = readBody(req);
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, message: 'Missing payment verification fields.' });
  }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    console.error('[verify-payment] RAZORPAY_KEY_SECRET missing from environment');
    return res.status(503).json({ success: false, message: 'Payment verification is not configured.' });
  }

  // 1. Signature check — proves the callback came from Razorpay, unmodified.
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (!safeEqual(expected, razorpay_signature)) {
    console.warn('[verify-payment] signature mismatch for order', razorpay_order_id);
    return res.status(400).json({ success: false, message: 'Invalid payment signature.' });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[verify-payment] database unavailable', err.message);
    return res.status(503).json({ success: false, message: 'Could not record your order. Please contact support.' });
  }

  try {
    const snap = await db.ref('orders')
      .orderByChild('razorpayOrderId')
      .equalTo(razorpay_order_id)
      .once('value');

    const match = snap.val();
    if (!match) {
      console.error('[verify-payment] no order matches Razorpay order', razorpay_order_id);
      return res.status(404).json({ success: false, message: 'Order not found for this payment.' });
    }

    const internalId = Object.keys(match)[0];
    const order = match[internalId];

    // 2. Idempotency: browsers retry callbacks. Never move stock twice.
    if (order.paymentStatus === 'paid') {
      return res.status(200).json({ success: true, orderId: internalId, alreadyVerified: true });
    }

    const now = new Date().toISOString();
    await db.ref('orders/' + internalId).update({
      paymentStatus: 'paid',
      status: 'confirmed',
      razorpayPaymentId: razorpay_payment_id,
      paidAt: now,
      updatedAt: now
    });

    // 3. Stock moves only after the payment is proven.
    await applyStockDelta(db, order.items || []);

    return res.status(200).json({ success: true, orderId: internalId, amount: order.amount && order.amount.total });
  } catch (err) {
    // The payment is real even if bookkeeping failed — log it and tell the
    // customer it went through so they are not charged twice.
    console.error('[verify-payment] post-payment bookkeeping failed', {
      razorpayOrderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      error: err.message
    });
    return res.status(500).json({
      success: false,
      message: 'Your payment succeeded but we could not finalise the order. Our team will confirm it shortly.'
    });
  }
};
