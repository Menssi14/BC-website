// ============================================================
//  Broch Custom — Payment history (Vercel Function)
//  Lives at /api/payments. Returns recent Square payments for
//  the Orders app's hidden history view. Uses the SAME secret
//  token as pay.js (from Vercel env vars) — never in the browser.
// ============================================================

export default async function handler(req, res) {
  const ENV = process.env.SQUARE_ENV === 'production' ? 'production' : 'sandbox';
  const BASE = ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

  // Last 90 days, newest first
  const begin = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const url = `${BASE}/v2/payments?sort_order=DESC&begin_time=${encodeURIComponent(begin)}&limit=100`;

  try {
    const r = await fetch(url, {
      headers: {
        'Square-Version': '2025-01-23',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].detail) || 'Could not load payments.';
      return res.status(r.status).json({ ok: false, error: msg });
    }
    // Trim to just what the history view needs
    const payments = (data.payments || []).map(p => ({
      id: p.id,
      amount: p.amount_money ? p.amount_money.amount : 0,
      status: p.status,
      createdAt: p.created_at,
      receipt: p.receipt_number || '',
      email: p.buyer_email_address || '',
      note: p.note || '',
      cardBrand: (p.card_details && p.card_details.card && p.card_details.card.card_brand) || '',
      last4: (p.card_details && p.card_details.card && p.card_details.card.last_4) || ''
    }));
    return res.status(200).json({ ok: true, payments });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Payment service unavailable.' });
  }
}
