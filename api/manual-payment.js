// Broch Custom — private Orders app payment endpoint.
// Card/ACH details never reach this endpoint; Square Web Payments SDK sends
// only a one-time source token. This endpoint intentionally does not create a
// new website order because staff is collecting payment for an existing job.
import { randomUUID } from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });
  const { sourceId, amountCents, email, note } = req.body || {};
  if (!sourceId || !Number.isInteger(amountCents) || amountCents < 50) {
    return res.status(400).json({ ok:false, error:'Invalid payment request.' });
  }
  const ENV = process.env.SQUARE_ENV === 'production' ? 'production' : 'sandbox';
  const BASE = ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  const payload = {
    source_id: sourceId,
    idempotency_key: randomUUID(),
    amount_money: { amount: amountCents, currency:'USD' },
    location_id: process.env.SQUARE_LOCATION_ID,
    note: String(note || 'Orders app payment').slice(0,500)
  };
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) payload.buyer_email_address = email;
  try {
    const r = await fetch(`${BASE}/v2/payments`, {
      method:'POST',
      headers:{
        'Square-Version':'2026-09-16',
        'Authorization':`Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok || !data.payment) {
      const msg = data && data.errors && data.errors[0] && data.errors[0].detail;
      return res.status(r.status || 400).json({ ok:false, error:msg || 'Square declined the payment.' });
    }
    const p=data.payment;
    if (p.status !== 'COMPLETED' && p.status !== 'PENDING' && p.status !== 'APPROVED') {
      return res.status(400).json({ ok:false, error:`Payment status: ${p.status || 'unknown'}. No completed payment was recorded.` });
    }
    return res.status(200).json({
      ok:true,
      pending:p.status !== 'COMPLETED',
      status:p.status,
      id:p.id,
      receipt:p.receipt_number || '',
      receiptUrl:p.receipt_url || ''
    });
  } catch (e) {
    console.error('[manual-payment]', e);
    return res.status(500).json({ ok:false, error:'Could not reach Square. Try again.' });
  }
}
