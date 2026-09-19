/**
 * Shared server utilities for the Coco Rush API routes.
 * ---------------------------------------------------------------------------
 * The Admin SDK bypasses Realtime Database security rules, which is exactly
 * what we want: the browser can never write an order or move stock, only the
 * server can, and it re-derives every amount from the database.
 */
const admin = require('firebase-admin');

const MAX_QTY_PER_LINE = 20;
const MAX_ORDER_VALUE = 500000; // ₹5,00,000 sanity ceiling

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
  return admin.database();
}

/** Normalise RTDB nodes that may be arrays, keyed objects, or absent. */
function toArray(node) {
  if (!node) return [];
  return Array.isArray(node) ? node.filter(Boolean) : Object.values(node);
}

/** Trim and collapse whitespace so `"  Rahul   Sharma "` and `"Rahul Sharma"` agree. */
const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

/**
 * Validate delivery details. Liberal on format (Postel's law), strict on
 * anything that would produce an undeliverable order.
 */
function normaliseCustomer(input) {
  const c = input || {};
  const customer = {
    name: clean(c.name),
    phone: clean(c.phone).replace(/[^\d+]/g, ''),
    address: clean(c.address),
    city: clean(c.city),
    pin: clean(c.pin).replace(/\D/g, ''),
    email: clean(c.email).toLowerCase()
  };

  const errors = [];
  if (customer.name.length < 2) errors.push('name');
  if (customer.phone.replace(/\D/g, '').length < 10) errors.push('phone');
  if (customer.address.length < 8) errors.push('address');
  if (customer.city.length < 2) errors.push('city');
  if (customer.pin.length !== 6) errors.push('pincode');

  return { customer, errors };
}

/**
 * Re-price a cart directly from the products node.
 * The client may only send `{ productId, qty }`; every figure the customer is
 * charged is computed here, so a tampered cart cannot alter the total.
 */
async function priceCart(db, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    const err = new Error('Your cart is empty.');
    err.status = 400;
    throw err;
  }

  const snap = await db.ref('products').once('value');
  const products = toArray(snap.val());

  const lines = rawItems.map((raw) => {
    const qty = Math.floor(Number(raw && raw.qty));
    if (!raw || !raw.productId) {
      const err = new Error('A cart line is missing its product reference.');
      err.status = 400;
      throw err;
    }
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      const err = new Error(`Invalid quantity for product ${raw.productId} (max ${MAX_QTY_PER_LINE}).`);
      err.status = 400;
      throw err;
    }

    const product = products.find((p) => p && String(p.id) === String(raw.productId));
    if (!product) {
      const err = new Error('A product in your cart is no longer available.');
      err.status = 409;
      throw err;
    }

    const price = parseFloat(product.price);
    if (!Number.isFinite(price) || price <= 0) {
      const err = new Error(`Product "${product.title}" has no valid price.`);
      err.status = 409;
      throw err;
    }

    const stock = Number(product.stock || 0);
    if (stock < qty) {
      const err = new Error(`Only ${stock} left of "${product.title}".`);
      err.status = 409;
      throw err;
    }

    return {
      productId: product.id,
      title: product.title,
      label: product.label || 'Pack',
      price,
      qty,
      lineTotal: Number((price * qty).toFixed(2))
    };
  });

  const subtotal = Number(lines.reduce((sum, l) => sum + l.lineTotal, 0).toFixed(2));
  const shipping = 0;
  const total = Number((subtotal + shipping).toFixed(2));

  if (total <= 0 || total > MAX_ORDER_VALUE) {
    const err = new Error('Order total is outside the accepted range.');
    err.status = 400;
    throw err;
  }

  return { lines, subtotal, shipping, total, currency: 'INR' };
}

/**
 * Decrement stock and increment sold counters inside a transaction per product,
 * so two simultaneous payments can never oversell the same unit.
 */
async function applyStockDelta(db, lines) {
  await Promise.all(lines.map((line) => db.ref('products/' + line.productId).transaction((product) => {
    if (!product) return product; // product deleted mid-flight: leave it alone
    const stock = Number(product.stock || 0);
    product.stock = Math.max(0, stock - line.qty);
    product.sold = Number(product.sold || 0) + line.qty;
    return product;
  })));
}

/** RTDB keys may not contain . $ # [ ] / — order ids are opaque, so sanitise. */
const safeKey = (value) => String(value || '').replace(/[.#$\[\]/]/g, '_');

module.exports = {
  admin,
  getDb,
  toArray,
  clean,
  normaliseCustomer,
  priceCart,
  applyStockDelta,
  safeKey,
  MAX_QTY_PER_LINE
};
