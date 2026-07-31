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
  const headlineHtml = kind === 'paid'
    ? 'We received your payment &mdash; thank you!'
    : 'Your order is ready for pickup!';
  const closing = kind === 'paid'
    ? "We're getting started on your order and will let you know when it's ready."
    : 'See you soon!';
  const calloutLabel = kind === 'paid' ? 'QUESTIONS? CONTACT US' : 'PICK UP AT';

  const text = [
    hi, '',
    headline, '',
    'Broch Custom · Edinburg, TX',
    'Call or text: (956) 225-5859',
    '', closing,
    'Reply to this email with any questions.',
    '', 'brochcustom.com'
  ].join('\n');

  const html =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2EADD" style="background:#F2EADD;margin:0;padding:24px 12px;font-family:Georgia,'Times New Roman',serif">` +
     `<tr><td align="center">` +
      `<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:520px;background:#fffdf8;border:1px solid #e3dac6;border-radius:12px;overflow:hidden">` +
        // header wordmark (text, so it never breaks and is never blocked)
        `<tr><td bgcolor="#1F4D3E" style="background:#1F4D3E;padding:22px 26px">` +
          `<div style="font-family:Georgia,'Times New Roman',serif;color:#F2EADD;font-size:23px;font-weight:bold;letter-spacing:.14em;line-height:1">BROCH CUSTOM</div>` +
          `<div style="font-family:Arial,Helvetica,sans-serif;color:#E9B9B4;font-size:11px;letter-spacing:.22em;margin-top:6px">CUSTOM APPAREL &middot; EDINBURG, TX</div>` +
        `</td></tr>` +
        // greeting + headline
        `<tr><td style="padding:26px 26px 6px;color:#2c2620;font-size:15px;line-height:1.6">` +
          `<p style="margin:0 0 14px">${esc(hi)}</p>` +
          `<p style="margin:0;font-size:21px;line-height:1.3;color:#1F4D3E"><strong>${headlineHtml}</strong></p>` +
        `</td></tr>` +
        // callout card
        `<tr><td style="padding:18px 26px 6px">` +
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f1;border:1px solid #d8e2d8;border-radius:10px">` +
            `<tr><td style="padding:16px 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#2c2620">` +
              `<div style="font-size:11px;letter-spacing:.16em;color:#6a7d6f;margin-bottom:7px">${calloutLabel}</div>` +
              `<div style="font-size:16px;color:#1F4D3E;font-weight:bold">Broch Custom</div>` +
              `<div style="color:#4A3424">Edinburg, TX</div>` +
              `<div style="margin-top:9px">Call or text <a href="tel:9562255859" style="color:#1F4D3E;text-decoration:none;font-weight:bold">(956) 225-5859</a></div>` +
            `</td></tr>` +
          `</table>` +
        `</td></tr>` +
        // closing
        `<tr><td style="padding:16px 26px 24px;color:#2c2620;font-size:15px;line-height:1.6">` +
          `<p style="margin:0">${closing} Reply to this email with any questions.</p>` +
        `</td></tr>` +
        // footer
        `<tr><td bgcolor="#1F4D3E" style="background:#1F4D3E;padding:15px 26px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#cfe0d6;text-align:center">` +
          `Broch Custom &middot; Edinburg, TX &middot; <a href="https://brochcustom.com" style="color:#E9B9B4;text-decoration:none">brochcustom.com</a>` +
        `</td></tr>` +
      `</table>` +
     `</td></tr>` +
    `</table>`;

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
