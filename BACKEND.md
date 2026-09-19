# Coco Rush — Backend

The storefront is static; every privileged action runs on the server. This
document covers the data model, security rules, environment variables and the
steps to go live.

```
index.html          storefront (UI only — talks to store.js)
app-config.js       PUBLIC runtime config (Firebase web config, Razorpay key id)
store.js            data layer: realtime reads, auth, admin writes, API calls
database.rules.json Realtime Database security rules
.env.example        SERVER-ONLY secrets template
api/
  _firebase.js      shared Admin SDK init + pricing/stock helpers
  create-order.js   POST /api/create-order   — prices the cart, creates the payment
  verify-payment.js POST /api/verify-payment — verifies the HMAC, marks paid, moves stock
```

## Trust boundaries

| Concern | Where it is decided | Why |
|---|---|---|
| Order total | `api/_firebase.js` → `priceCart()` | The browser sends only `{ productId, qty }`. A tampered price or amount in the DOM changes nothing. |
| Payment authenticity | `api/verify-payment.js` | HMAC-SHA256 over `order_id\|payment_id` using the key **secret**, which never leaves the server. Compared with `crypto.timingSafeEqual`. |
| Stock movement | Server transactions | `applyStockDelta()` runs a RTDB transaction per product, so two simultaneous payments cannot oversell the last unit. |
| Customer passwords | Firebase Auth | Never stored, never sent to the database. The old plaintext-in-localStorage scheme is gone. |
| Admin writes | Security rules | Products, media, settings, expenses and orders require a custom claim (`auth.token.admin === true`). |

## Data model

```
settings/store       { name, phone, email, address, currency }
settings/logo        "<url>"
products/{id}        { id, title, label, price, mrp, cp, stock, sold, img, sortOrder, active }
media/{id}           { id, type: 'photo'|'video', url, createdAt }
customers/{uid}      { uid, name, email, phone, createdAt }
orders/{id}          { orderId, razorpayOrderId, razorpayPaymentId, method, customer,
                       items[], amount{subtotal,shipping,total,currency},
                       status, paymentStatus, createdAt, paidAt }
expenses/{id}        { id, name, amount, type, date, reason }
reviews/{id}         { productId, uid, name, rating, text, createdAt }
```

Collections are stored as **objects keyed by id**, not arrays. A Realtime
Database array is rewritten as a whole on every write, which silently clobbers
concurrent edits — keyed nodes let `applyStockDelta` patch one product at a time.

`products.sold` and `products.stock` are the counters the ERP reads; the server
owns both, so the analytics screen reflects real sales rather than optimistic
client maths.

## Order lifecycle

```
COD / WhatsApp
  create-order (method: 'cod')
    → validate customer → price cart → write order{pending}
    → reserve stock (transaction) → return { orderId }

Prepaid (Razorpay)
  create-order (method: 'razorpay')
    → validate customer → price cart → create Razorpay order
    → write order{paymentStatus:'pending'} → return { orderId, razorpayOrderId, amount }

  Razorpay checkout succeeds
    → verify-payment
        → recompute HMAC (reject on mismatch)
        → find order by razorpayOrderId
        → idempotent: already paid? return early (no double stock movement)
        → mark paid + confirmed
        → applyStockDelta()
```

If bookkeeping fails *after* a real payment, the endpoint returns 500 with the
payment id and logs a structured payload — the customer is never told the
payment failed, and the record is reconcilable.

## Setup

### 1. Firebase

1. Create a project → **Realtime Database** → create it.
2. Add a Web app, then copy the config into `app-config.js` → `firebase`.
3. Copy `databaseURL` into `.env` as `FIREBASE_DATABASE_URL`.
4. Project settings → **Service accounts** → *Generate new private key*. Paste
   the JSON **minified onto one line** as `FIREBASE_SERVICE_ACCOUNT` in `.env`.

### 2. Grant yourself admin

Admin routes require the `admin` custom claim. Run once, locally:

```bash
node -e "
const admin=require('firebase-admin');
admin.initializeApp({credential:admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});
admin.auth().setCustomUserClaims('<YOUR_UID>',{admin:true}).then(()=>console.log('admin claim set'));
"
```

The user must then sign out and back in for the claim to appear on the token.
Until then, `products`, `media`, `settings` and `expenses` are read-only.

### 3. Razorpay

1. Dashboard → Settings → API keys → generate.
2. `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` → `.env`.
3. The **key id** is duplicated into `app-config.js` (it is public). The
   **secret** belongs in `.env` only — never in `app-config.js`.

### 4. Deploy the rules

`.env` values and `database.rules.json` are not applied automatically:

```bash
npm i -g firebase-tools
firebase login
firebase deploy --only database   # uses database.rules.json
```

Or paste `database.rules.json` into Console → Realtime Database → **Rules**.

## Offline / preview mode

If `app-config.js` still contains `REPLACE_WITH…`, `store.js` logs
*"running in offline mode"* and everything falls back to `localStorage`:

- the storefront renders and the cart works,
- admin screens remain usable for design review,
- `create-order` / `verify-payment` are simply unavailable.

This is a deliberate resilience choice — a misconfigured deploy degrades
instead of throwing on every page load. It is **not** a substitute for Firebase
in production: orders placed offline exist only in that one browser.

## Known gaps

- **Images** are stored as data-URIs in the database. A full-size product photo
  becomes a multi-hundred-kilobyte node on every read. Move uploads to **Firebase
  Storage** and store the download URL instead — the `media.url` field already
  takes any string.
- **Admin access** is still gated by `ADMIN_PIN` in the client, which anyone
  reading the source can find. Replace it with the Firebase Auth `admin` claim
  (already enforced by the rules) and delete the PIN path.
- **Razorpay webhooks** are not wired. `verify-payment` covers the browser
  callback; a webhook would also catch payments where the customer closed the
  tab mid-flow. Add `api/razorpay-webhook.js` when you need that safety net.
