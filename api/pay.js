// ============================================================
//  Broch Custom — Square payment backend (Vercel Function)
//  This file lives at /api/pay and is the ONLY place your
//  secret Square access token is ever used. It never reaches
//  the browser.
//
//  SETUP (one time):
//  1. Put this file at  api/pay.js  in your Vercel project.
//  2. In Vercel → Project → Settings → Environment Variables, add:
//        SQUARE_ACCESS_TOKEN   = your secret token (sandbox first)
//        SQUARE_LOCATION_ID    = your location id (the L... value)
//        SQUARE_ENV            = sandbox     (change to "production" when live)
//     NEVER paste the token into any other file.
//  3. Deploy. The website's PAYMENT_ENDPOINT ('/api/pay') will reach this.
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { sourceId, amountCents, email, phone, items } = req.body || {};

  // Basic validation — never trust the browser blindly
  if (!sourceId || !Number.isInteger(amountCents) || amountCents < 50) {
    return res.status(400).json({ ok: false, error: 'Invalid payment request.' });
  }

  const ENV = process.env.SQUARE_ENV === 'production' ? 'production' : 'sandbox';
  const BASE = ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

  // Build the charge.
  const payload = {
    source_id: sourceId,
    idempotency_key: crypto.randomUUID(),     // prevents accidental double-charges
    amount_money: { amount: amountCents, currency: 'USD' },
    location_id: process.env.SQUARE_LOCATION_ID
  };
  // If the customer gave an email, Square emails them a receipt.
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    payload.buyer_email_address = email;
  }
  // Attach the phone so it shows on the payment in your Square dashboard.
  if (phone && /^\d{10,15}$/.test(phone)) {
    payload.buyer_phone_number = '+1' + phone.slice(-10);
    payload.note = 'Website order — call/text +1' + phone.slice(-10);
  }

  try {
    const response = await fetch(`${BASE}/v2/payments`, {
      method: 'POST',
      headers: {
        'Square-Version': '2025-01-23',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (response.ok && data.payment && data.payment.status === 'COMPLETED') {
      // ── Drop the paid order into the Orders app ──
      // The orders app stores everything as one JSON file in Supabase
      // storage (bucket "files", path "_orders/orders.json", shape
      // {v:10, orders:[...]}). We download it, append this order in the
      // exact shape the app expects, and re-upload. If anything here
      // fails, the PAYMENT STILL SUCCEEDS — we never break a real charge.
      try {
        const SB = process.env.SUPABASE_URL;
        const KEY = process.env.SUPABASE_KEY;
        if (SB && KEY) {
          const FILE = '_orders/orders.json';
          const base = `${SB}/storage/v1/object/files/${FILE}`;
          const hdr = { 'apikey': KEY, 'Authorization': `Bearer ${KEY}` };

          // 1) download current orders file
          let store = { v: 10, orders: [] };
          try {
            const cur = await fetch(base, { headers: hdr });
            if (cur.ok) {
              const parsed = await cur.json();
              if (parsed && Array.isArray(parsed.orders)) store = parsed;
            }
          } catch (_) { /* file may not exist yet — start fresh */ }

          // 2) append the paid order in the app's order shape
          const now = Date.now();
          const phone10 = phone ? phone.slice(-10) : '';
          store.orders.push({
            id: 'o' + now.toString(36) + Math.random().toString(36).slice(2, 6),
            type: 'NOTE',
            title: 'Website order',
            contact: phone10,
            body: (items ? String(items).slice(0, 2000) + '\n\n' : '') +
                  'Paid online: $' + (amountCents / 100).toFixed(2) +
                  (data.payment.receipt_number ? ' · Receipt ' + data.payment.receipt_number : ''),
            urgency: 'asap',
            designReady: false,
            items: [],
            images: [],
            due: '', duePreset: '',
            trashed: false, trashedAt: null,
            source: 'online',
            paidCents: amountCents,
            paymentId: data.payment.id,
            receipt: data.payment.receipt_number || '',
            customerEmail: (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) ? email : '',
            createdAt: now, updatedAt: now
          });

          // 3) re-upload (upsert)
          await fetch(base, {
            method: 'POST',
            headers: { ...hdr, 'Content-Type': 'application/json', 'x-upsert': 'true' },
            body: JSON.stringify(store)
          });
        }
      } catch (logErr) {
        console.error('[orders] could not log order:', logErr);
      }

      return res.status(200).json({
        ok: true,
        id: data.payment.id,
        receipt: data.payment.receipt_number || data.payment.id
      });
    }
    const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Payment declined.';
    return res.status(402).json({ ok: false, error: msg });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Payment service unavailable. No charge was made.' });
  }
}
