// Broch Custom — Orders app payment endpoint.
// - Staff card entry: charges a one-time Square token.
// - ACH: creates a signed customer payment link and later charges the bank token
//   from the public ach-pay.html page. The customer never enters the Orders app.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';

const VERSION = '2026-09-16';
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function envBase() {
  return process.env.SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}
function secret() {
  return process.env.ACH_LINK_SECRET || process.env.SQUARE_ACCESS_TOKEN || '';
}
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function sign(body) {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}
function makeToken(payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}
function parseToken(token) {
  if (!token || typeof token !== 'string' || !secret()) throw new Error('Invalid payment link.');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid payment link.');
  const expected = Buffer.from(sign(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid payment link.');
  const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  if (!data || !Number.isInteger(data.amountCents) || data.amountCents < 50) throw new Error('Invalid payment link.');
  if (!data.exp || Date.now() > data.exp) throw new Error('This payment link has expired.');
  return data;
}
function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) throw new Error('Could not determine site address.');
  return `${proto}://${host}`;
}
function validEmail(email) {
  return email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

async function squareCharge({ sourceId, amountCents, email, note, idempotencyKey }) {
  const payload = {
    source_id: sourceId,
    idempotency_key: idempotencyKey || randomUUID(),
    amount_money: { amount: amountCents, currency: 'USD' },
    location_id: process.env.SQUARE_LOCATION_ID,
    note: String(note || 'Orders app payment').slice(0, 500)
  };
  if (validEmail(email)) payload.buyer_email_address = email;

  const r = await fetch(`${envBase()}/v2/payments`, {
    method: 'POST',
    headers: {
      'Square-Version': VERSION,
      'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!r.ok || !data.payment) {
    const msg = data && data.errors && data.errors[0] && data.errors[0].detail;
    const err = new Error(msg || 'Square declined the payment.');
    err.status = r.status || 400;
    throw err;
  }
  return data.payment;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const body = req.body || {};
  const action = body.action || 'chargeCard';

  try {
    if (action === 'createAchLink') {
      const amountCents = Number(body.amountCents);
      if (!Number.isInteger(amountCents) || amountCents < 50) {
        return res.status(400).json({ ok: false, error: 'Enter a valid ACH amount.' });
      }
      if (!secret()) return res.status(500).json({ ok: false, error: 'ACH link signing is not configured.' });
      const payload = {
        amountCents,
        name: String(body.name || '').slice(0, 120),
        email: validEmail(body.email) ? String(body.email).slice(0, 254) : '',
        note: String(body.note || 'Broch Custom ACH payment').slice(0, 300),
        nonce: randomBytes(16).toString('hex'),
        exp: Date.now() + LINK_TTL_MS
      };
      const token = makeToken(payload);
      const url = `${requestOrigin(req)}/ach-pay.html?t=${encodeURIComponent(token)}`;
      return res.status(200).json({ ok: true, url, expiresAt: payload.exp });
    }

    if (action === 'getAchLink') {
      const link = parseToken(body.token);
      return res.status(200).json({
        ok: true,
        amountCents: link.amountCents,
        name: link.name || '',
        email: link.email || '',
        expiresAt: link.exp
      });
    }

    if (action === 'payAchLink') {
      if (!body.sourceId) return res.status(400).json({ ok: false, error: 'Bank authorization is missing.' });
      const link = parseToken(body.token);
      const payment = await squareCharge({
        sourceId: body.sourceId,
        amountCents: link.amountCents,
        email: link.email,
        note: link.note || 'Broch Custom ACH payment',
        // Same link cannot accidentally charge twice if the customer retries.
        idempotencyKey: `ach-${link.nonce}`
      });
      if (!['COMPLETED', 'PENDING', 'APPROVED'].includes(payment.status)) {
        return res.status(400).json({ ok: false, error: `Payment status: ${payment.status || 'unknown'}.` });
      }
      return res.status(200).json({
        ok: true,
        pending: payment.status !== 'COMPLETED',
        status: payment.status,
        id: payment.id,
        receipt: payment.receipt_number || '',
        receiptUrl: payment.receipt_url || ''
      });
    }

    // Staff-entered card payment from the private Orders app.
    const { sourceId, amountCents, email, note } = body;
    if (!sourceId || !Number.isInteger(amountCents) || amountCents < 50) {
      return res.status(400).json({ ok: false, error: 'Invalid payment request.' });
    }
    const payment = await squareCharge({ sourceId, amountCents, email, note });
    if (!['COMPLETED', 'PENDING', 'APPROVED'].includes(payment.status)) {
      return res.status(400).json({ ok: false, error: `Payment status: ${payment.status || 'unknown'}. No completed payment was recorded.` });
    }
    return res.status(200).json({
      ok: true,
      pending: payment.status !== 'COMPLETED',
      status: payment.status,
      id: payment.id,
      receipt: payment.receipt_number || '',
      receiptUrl: payment.receipt_url || ''
    });
  } catch (e) {
    console.error('[manual-payment]', e);
    return res.status(e.status || 500).json({ ok: false, error: e.message || 'Could not reach Square. Try again.' });
  }
}
