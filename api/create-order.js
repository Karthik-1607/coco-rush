/**
 * POST /api/create-order
 * ---------------------------------------------------------------------------
 * The single entry point for placing an order. Responsibilities:
 *   1. Validate the customer's delivery details.
 *   2. Re-price the cart from the database (never trusts client amounts).
 *   3. For prepaid orders, create a Razorpay order server-side.
 *   4. Persist the order as `pending` so payment can be reconciled later.
 *
 * Body: { items: [{ productId, qty }], customer: {...}, method: 'razorpay'|'cod' }
 * Env:  FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL,
 *       RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
 */
const Razorpay = require('razorpay');
const { getDb, normaliseCustomer, priceCart, applyStockDelta, safeKey } = require('./_firebase');

const readBody = (req) => {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (err) { return {}; }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[create-order] database unavailable', err.message);
    return res.status(503).json({ message: 'Ordering is temporarily unavailable. Please try again shortly.' });
  }

  const body = readBody(req);
  const method = body.method === 'cod' ? 'cod' : 'razorpay';

  const { customer, errors } = normaliseCustomer(body.customer);
  if (errors.length) {
    return res.status(400).json({ message: 'Please check: ' + errors.join(', ') + '.', fields: errors });
  }

  let priced;
  try {
    priced = await priceCart(db, body.items);
  } catch (err) {
    return res.status(err.status || 500).json({ message: err.message });
  }

  const now = new Date().toISOString();
  const orderRef = db.ref('orders').push();
  const orderId = orderRef.key;

  // Razorpay order ids are opaque and URL-safe; keep our own key for the
  // reverse lookup so verification never has to scan the orders node.
  const baseOrder = {
    orderId,
    method,
    customer,
    items: priced.lines,
    amount: {
      subtotal: priced.subtotal, shipping: priced.shipping,
      total: priced.total, currency: priced.currency
    },
    status: 'placed',
    paymentStatus: method === 'cod' ? 'cod_pending' : 'pending',
    createdAt: now,
    updatedAt: now
  };

  if (method === 'cod') {
    try {
      await orderRef.set(baseOrder);
      // COD reserves inventory at order time: unlike a card payment there is no
      // gateway callback to trigger the stock movement later.
      await applyStockDelta(db, priced.lines);
      return res.status(200).json({ success: true, orderId, method, amount: priced.total, currency: priced.currency });
    } catch (err) {
      console.error('[create-order] COD persist failed', err);
      return res.status(500).json({ message: 'We could not place your order. Please try again.' });
    }
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    console.error('[create-order] Razorpay keys missing from environment');
    return res.status(503).json({ message: 'Online payment is not configured yet. Please choose Cash on Delivery.' });
  }

  try {
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const rzpOrder = await razorpay.orders.create({
      amount: Math.round(priced.total * 100), // paise
      currency: priced.currency,
      receipt: safeKey(orderId),
      notes: { cocorushOrderId: orderId, customerPhone: customer.phone }
    });

    await orderRef.set({ ...baseOrder, razorpayOrderId: rzpOrder.id });

    return res.status(200).json({
      success: true,
      orderId,
      razorpayOrderId: rzpOrder.id,
      amount: priced.total,
      currency: priced.currency,
      keyId
    });
  } catch (err) {
    console.error('[create-order] Razorpay order creation failed', err);
    await orderRef.remove().catch(() => {});
    return res.status(502).json({ message: 'Could not start the payment. Please try again.' });
  }
};
