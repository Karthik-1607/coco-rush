/**
 * Coco Rush — data layer.
 * ---------------------------------------------------------------------------
 * A single seam between the storefront UI and Firebase. The UI only ever talks
 * to `Store`, so:
 *   - no component needs to know a database path,
 *   - the app degrades to localStorage when Firebase is not configured,
 *   - privileged writes go through the API instead of the client.
 *
 * Database shape (Realtime Database):
 *   settings/store      { name, phone, email, address, currency }
 *   settings/logo       <url string>
 *   products/{id}       { id, title, label, price, mrp, cp, stock, sold, img, sortOrder, active }
 *   media/{id}          { id, type: 'photo'|'video', url, createdAt }
 *   customers/{uid}     { uid, name, email, phone }         (never a password)
 *   orders/{id}         { orderId, razorpayOrderId, paymentStatus, customer, items, amount, status }
 *   expenses/{id}       { id, name, amount, type, date, reason }
 *   reviews/{id}        { productId, uid, name, rating, text, createdAt }
 */
(function () {
  'use strict';

  const cfg = (window.COCORUSH_CONFIG || {});
  const LS = {
    products: 'cocorush_prods',
    media: 'cocorush_media',
    logo: 'cocorush_logo',
    expenses: 'cocorush_emp_payments',
    customer: 'cocorush_logged_customer'
  };

  // Detect placeholder config so an unconfigured deploy still runs (offline mode)
  // instead of throwing on every page load.
  const looksPlaceholder = (v) => typeof v !== 'string' || v.indexOf('REPLACE_WITH') === 0;

  const state = {
    online: false,
    ready: null,
    db: null,
    auth: null,
    user: null,
    listeners: new Set()
  };

  const readLS = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      console.warn('[store] unreadable localStorage key', key, err);
      return fallback;
    }
  };
  const writeLS = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* quota — non-fatal */ }
  };

  /** Normalise a RTDB node that may be an array, an object map, or absent. */
  const toArray = (node, sortKey) => {
    if (!node) return [];
    const list = Array.isArray(node) ? node.filter(Boolean) : Object.values(node);
    return sortKey ? list.sort((a, b) => (a[sortKey] || 0) - (b[sortKey] || 0)) : list;
  };

  const mapProduct = (p) => ({
    mrp: (p.mrp && p.mrp > 0) ? p.mrp : (parseFloat(p.price) * 1.25),
    label: p.label || 'Pack',
    sortOrder: p.sortOrder != null ? p.sortOrder : 0,
    ...p
  });

  function init() {
    if (state.ready) return state.ready;

    state.ready = new Promise((resolve) => {
      const fb = cfg.firebase;
      const usable = fb && !looksPlaceholder(fb.apiKey) && !looksPlaceholder(fb.databaseURL);

      if (!usable || typeof firebase === 'undefined') {
        console.info('[store] Firebase not configured — running in offline mode (localStorage only).');
        resolve(false);
        return;
      }

      try {
        if (!firebase.apps.length) firebase.initializeApp(fb);
        state.db = firebase.database();
        state.auth = firebase.auth ? firebase.auth() : null;
        state.online = true;

        // Persist the auth session so a returning visitor is not logged out.
        if (state.auth) {
          state.auth.onAuthStateChanged((user) => {
            state.user = user;
            if (user) {
              const profile = {
                name: user.displayName || (user.email || '').split('@')[0] || 'Customer',
                emailPhone: user.email || '',
                uid: user.uid,
                photo: user.photoURL || ''
              };
              writeLS(LS.customer, profile);
            } else {
              localStorage.removeItem(LS.customer);
            }
            state.listeners.forEach((fn) => fn({ type: 'auth', user }));
          });
        }
        resolve(true);
      } catch (err) {
        console.error('[store] Firebase init failed, continuing offline', err);
        resolve(false);
      }
    });

    return state.ready;
  }

  /** Subscribe to a storefront slice. Returns an unsubscribe function. */
  function watch(kind, onData) {
    // Only emit when something is actually cached. Emitting an empty list would
    // overwrite the caller's seeded defaults on a first visit.
    const applyLocal = () => {
      if (kind === 'products') {
        const stored = readLS(LS.products, null);
        if (stored && stored.length) onData(stored.map(mapProduct));
      } else if (kind === 'media') {
        const stored = readLS(LS.media, null);
        if (stored) onData(stored);
      } else if (kind === 'logo') {
        const stored = localStorage.getItem(LS.logo);
        if (stored) onData(stored);
      } else if (kind === 'expenses') {
        const stored = readLS(LS.expenses, null);
        if (stored) onData(stored);
      }
    };

    init().then((online) => {
      if (!online || !state.db) { applyLocal(); return; }

      const paths = { products: 'products', media: 'media', logo: 'settings/logo', expenses: 'expenses' };
      const ref = state.db.ref(paths[kind]);

      // Point listeners at the narrowest node possible: a root listener would
      // stream the entire database to every visitor and demand open read rules.
      ref.on('value', (snap) => {
        const val = snap.val();
        if (kind === 'products') {
          if (!val) return; // empty database — keep the seeded defaults on screen
          const list = toArray(val, 'sortOrder').map(mapProduct);
          writeLS(LS.products, list);
          onData(list);
        } else if (kind === 'media') {
          if (!val) return;
          const list = toArray(val);
          writeLS(LS.media, list);
          onData(list);
        } else if (kind === 'logo') {
          if (!val) return;
          localStorage.setItem(LS.logo, val);
          onData(val);
        } else if (kind === 'expenses') {
          const list = toArray(val);
          writeLS(LS.expenses, list);
          onData(list);
        }
      }, (err) => {
        // A rules rejection must not blank the storefront — fall back locally.
        console.warn('[store] read denied for', kind, err && err.message);
        applyLocal();
      });
    });

    return () => { if (state.db) state.db.ref().off(); };
  }

  /**
   * Write a keyed collection to the database.
   * Stored as an object keyed by id rather than an array: RTDB arrays are
   * rewritten wholesale, which silently clobbers concurrent edits.
   */
  function toKeyedMap(list) {
    return (list || []).reduce((acc, item, i) => {
      const id = item.id || ('item_' + i);
      acc[id] = { ...item, id };
      return acc;
    }, {});
  }

  async function saveProducts(list) {
    writeLS(LS.products, list);
    if (!state.online || !state.db) return { ok: true, offline: true };
    try {
      await state.db.ref('products').set(toKeyedMap(list));
      return { ok: true };
    } catch (err) {
      console.error('[store] saveProducts failed', err);
      return { ok: false, error: err.message };
    }
  }

  async function saveMedia(list) {
    writeLS(LS.media, list);
    if (!state.online || !state.db) return { ok: true, offline: true };
    try {
      await state.db.ref('media').set(toKeyedMap(list));
      return { ok: true };
    } catch (err) {
      console.error('[store] saveMedia failed', err);
      return { ok: false, error: err.message };
    }
  }

  async function saveLogo(url) {
    localStorage.setItem(LS.logo, url);
    if (!state.online || !state.db) return { ok: true, offline: true };
    try {
      await state.db.ref('settings/logo').set(url);
      return { ok: true };
    } catch (err) {
      console.error('[store] saveLogo failed', err);
      return { ok: false, error: err.message };
    }
  }

  async function saveExpenses(list) {
    writeLS(LS.expenses, list);
    if (!state.online || !state.db) return { ok: true, offline: true };
    try {
      await state.db.ref('expenses').set(toKeyedMap(list));
      return { ok: true };
    } catch (err) {
      console.error('[store] saveExpenses failed', err);
      return { ok: false, error: err.message };
    }
  }

  /** Mirror the inventory counters the ERP reads back out of the database. */
  async function commitStock(products) {
    const sold = products.map((p) => ({ id: p.id, stock: p.stock || 0, sold: p.sold || 0 }));
    writeLS(LS.products, products);
    if (!state.online || !state.db) return { ok: true, offline: true };
    try {
      const updates = {};
      sold.forEach((p) => {
        if (!p.id) return;
        updates['products/' + p.id + '/stock'] = p.stock;
        updates['products/' + p.id + '/sold'] = p.sold;
      });
      await state.db.ref().update(updates);
      return { ok: true };
    } catch (err) {
      console.error('[store] commitStock failed', err);
      return { ok: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------- auth ----

  /**
   * Firebase Auth needs an email. The signup form accepts "email or phone",
   * so a bare phone number is mapped to a stable synthetic address and the
   * real number is kept on the customer profile.
   */
  function toAuthEmail(input) {
    const value = (input || '').trim();
    if (value.includes('@')) return value.toLowerCase();
    const digits = value.replace(/\D/g, '');
    const domain = (cfg.store && cfg.store.phoneAuthDomain) || 'phone.cocorush.app';
    return digits + '@' + domain;
  }

  const describeAuthError = (err) => {
    const map = {
      'auth/email-already-in-use': 'An account with this email/phone already exists. Please log in.',
      'auth/invalid-email': 'That email address does not look right.',
      'auth/weak-password': 'Please choose a password with at least 6 characters.',
      'auth/user-not-found': 'No account found for those details. Please sign up.',
      'auth/wrong-password': 'Incorrect password. Please try again.',
      'auth/invalid-credential': 'Incorrect email/phone or password.',
      'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
      'auth/popup-closed-by-user': null // user cancelled — stay silent
    };
    return map[err && err.code] !== undefined ? map[err.code] : (err && err.message) || 'Something went wrong.';
  };

  async function signUpWithEmail(name, emailOrPhone, password) {
    await init();
    if (!state.auth) return { ok: false, error: 'Sign-up is unavailable right now. Please try again later.' };
    try {
      const email = toAuthEmail(emailOrPhone);
      const cred = await state.auth.createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName: name });
      const digits = emailOrPhone.replace(/\D/g, '');
      await state.db.ref('customers/' + cred.user.uid).set({
        uid: cred.user.uid, name: name, email: email, phone: digits.length >= 10 ? digits : null,
        createdAt: new Date().toISOString()
      });
      writeLS(LS.customer, { name, emailPhone: email, uid: cred.user.uid });
      return { ok: true, user: { name: name, emailPhone: email, uid: cred.user.uid } };
    } catch (err) {
      return { ok: false, error: describeAuthError(err) };
    }
  }

  async function signInWithEmail(emailOrPhone, password) {
    await init();
    if (!state.auth) return { ok: false, error: 'Login is unavailable right now. Please try again later.' };
    try {
      const email = toAuthEmail(emailOrPhone);
      const cred = await state.auth.signInWithEmailAndPassword(email, password);
      const user = cred.user;
      const profile = {
        name: user.displayName || (user.email || '').split('@')[0] || 'Customer',
        emailPhone: user.email || '', uid: user.uid, photo: user.photoURL || ''
      };
      writeLS(LS.customer, profile);
      return { ok: true, user: profile };
    } catch (err) {
      return { ok: false, error: describeAuthError(err) };
    }
  }

  async function signInWithGoogle() {
    await init();
    if (!state.auth) return { ok: false, error: 'Google Sign-In is unavailable right now.' };
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      const cred = await state.auth.signInWithPopup(provider);
      const user = cred.user;
      await state.db.ref('customers/' + user.uid).update({
        uid: user.uid, name: user.displayName || 'Coco Rush Customer',
        email: user.email || '', lastLoginAt: new Date().toISOString()
      });
      const profile = {
        name: user.displayName || 'Coco Rush Customer',
        emailPhone: user.email || '', uid: user.uid, photo: user.photoURL || ''
      };
      writeLS(LS.customer, profile);
      return { ok: true, user: profile };
    } catch (err) {
      const msg = describeAuthError(err);
      return { ok: false, error: msg, silent: msg === null };
    }
  }

  async function signOutUser() {
    localStorage.removeItem(LS.customer);
    if (state.auth) { try { await state.auth.signOut(); } catch (err) { console.warn('[store] signOut', err); } }
    return { ok: true };
  }

  // ---------------------------------------------------------------- api -----

  /** Call a serverless endpoint. Server re-prices every order it is given. */
  async function post(endpoint, body) {
    const base = cfg.apiBase || '/api';
    const res = await fetch(base + '/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    let payload = null;
    try { payload = await res.json(); } catch (err) { /* non-JSON error page */ }
    if (!res.ok) {
      const message = (payload && (payload.message || payload.error)) || ('Request failed (' + res.status + ')');
      throw new Error(message);
    }
    return payload || {};
  }

  async function placeCodOrder(order) {
    return post('create-order', { ...order, method: 'cod' });
  }

  window.CocoRushStore = {
    LS,
    init,
    watch,
    saveProducts,
    saveMedia,
    saveLogo,
    saveExpenses,
    commitStock,
    signUpWithEmail,
    signInWithEmail,
    signInWithGoogle,
    signOutUser,
    post,
    placeCodOrder,
    get online() { return state.online; },
    get user() { return state.user; }
  };
})();
