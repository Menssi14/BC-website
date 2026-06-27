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

  const { sourceId, amountCents } = req.body || {};

  // Basic validation — never trust the browser blindly
  if (!sourceId || !Number.isInteger(amountCents) || amountCents < 50) {
    return res.status(400).json({ ok: false, error: 'Invalid payment request.' });
  }

  const ENV = process.env.SQUARE_ENV === 'production' ? 'production' : 'sandbox';
  const BASE = ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

  try {
    const response = await fetch(`${BASE}/v2/payments`, {
      method: 'POST',
      headers: {
        'Square-Version': '2025-01-23',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: crypto.randomUUID(),     // prevents accidental double-charges
        amount_money: { amount: amountCents, currency: 'USD' },
        location_id: process.env.SQUARE_LOCATION_ID
      })
    });

    const data = await response.json();

    if (response.ok && data.payment && data.payment.status === 'COMPLETED') {
      return res.status(200).json({ ok: true, id: data.payment.id });
    }
    const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Payment declined.';
    return res.status(402).json({ ok: false, error: msg });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Payment service unavailable. No charge was made.' });
  }
}
