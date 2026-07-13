// ============================================================
//  Broch Custom — "Order ready" email (Vercel Function)
//  This file lives at  api/notify.js  — a NEW file. It does NOT
//  touch api/pay.js or anything about payments.
//
//  The Orders app calls this when you tap ✉ Ready on an order
//  that has a customer email. It sends one fixed, friendly
//  "your order is ready for pickup" email — nothing else can
//  be sent through it, so it can't be abused to send arbitrary
//  messages from your Gmail.
//
//  Uses the SAME environment variables pay.js already uses:
//    GMAIL_USER, GMAIL_APP_PASSWORD
// ============================================================

import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const b = req.body || {};
  const email = (b.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) ? String(b.email).slice(0, 200) : '';
  const name  = String(b.name || '').slice(0, 120).trim();
  const kind  = (b.kind === 'paid') ? 'paid' : 'ready';   // only two fixed messages exist

  if (!email) return res.status(400).json({ ok: false, error: 'No customer email on this order.' });

  const MAIL_USER = process.env.GMAIL_USER;
  const MAIL_PASS = process.env.GMAIL_APP_PASSWORD;
  if (!MAIL_USER || !MAIL_PASS) {
    return res.status(500).json({ ok: false, error: 'Email is not configured.' });
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const hi = name ? 'Hi ' + name + ',' : 'Hi,';

  const headline = kind === 'paid'
    ? 'We received your payment — thank you!'
    : 'Good news — your order is ready for pickup at Broch Custom!';
  const closing = kind === 'paid'
    ? "We're getting started on your order and will let you know when it's ready."
    : 'See you soon!';

  const text = [
    hi, '',
    headline, '',
    'Broch Custom · Edinburg, TX',
    'Call or text: (956) 225-5859',
    '', closing
  ].join('\n');

  const html =
    `<div style="font-family:Georgia,'Times New Roman',serif;background:#F2EADD;padding:26px 16px">` +
      `<div style="max-width:520px;margin:0 auto;background:#fffdf8;border:1px solid #e3dac6;border-radius:10px;overflow:hidden">` +
        `<div style="background:#1F4D3E;padding:18px 22px"><img src="https://brochcustom.com/broch-email-logo.png" width="216" alt="BROCH CUSTOM" style="display:block;border:0;height:auto;max-width:72%;color:#F2EADD;font-size:19px;letter-spacing:.08em"></div>` +
        `<div style="padding:22px;color:#2c2620;font-size:15px;line-height:1.55">` +
          `<p style="margin:0 0 12px">${esc(hi)}</p>` +
          `<p style="margin:0 0 14px;font-size:17px"><strong>${kind === 'paid' ? 'We received your payment &mdash; thank you!' : 'Good news &mdash; your order is ready for pickup!'}</strong></p>` +
          `<p style="margin:0 0 6px;color:#4A3424">🏬 Broch Custom &middot; Edinburg, TX</p>` +
          `<p style="margin:0 0 14px;color:#4A3424">📞 Call or text <a href="tel:9562255859" style="color:#1F4D3E">(956) 225-5859</a></p>` +
          `<p style="margin:0;color:#4A3424">${kind === 'paid' ? "We're getting started on your order and will let you know when it's ready." : 'See you soon!'} Reply to this email with any questions.</p>` +
        `</div>` +
      `</div>` +
    `</div>`;

  try {
    const mailer = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: MAIL_USER, pass: MAIL_PASS }
    });
    await mailer.sendMail({
      from: `"Broch Custom" <${MAIL_USER}>`,
      to: email,
      subject: kind === 'paid' ? 'Payment received — Broch Custom' : 'Your order is ready for pickup — Broch Custom',
      text, html
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[notify] send failed:', e);
    return res.status(500).json({ ok: false, error: 'Could not send the email.' });
  }
}
