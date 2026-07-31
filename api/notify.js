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
    : 'Good news &mdash; your order is ready for pickup!';
  const closing = kind === 'paid'
    ? "We're getting started on your order and will let you know when it's ready."
    : 'See you soon!';

  const text = [
    hi, '',
    headline, '',
    'Broch Custom · Embroidery · Printing · Engraving',
    'Edinburg, TX',
    'Call or text: (956) 225-5859',
    'Email: brochcustom@gmail.com',
    '', closing,
    'Reply to this email with any questions.',
    '', 'brochcustom.com'
  ].join('\n');

  // Brand fonts (EB Garamond + Teko) load in clients that support web fonts (e.g. Apple Mail);
  // everywhere else these stacks fall back to Georgia / Arial. The Schadow logo is an image so it
  // shows exactly right wherever images are allowed (with a styled text fallback if they're blocked).
  const SERIF = "'EB Garamond', Georgia, 'Times New Roman', serif";
  const LABEL = "'Teko', 'Arial Narrow', Arial, sans-serif";

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">` +
    `<style>@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Teko:wght@400;500&display=swap');body{margin:0;padding:0}</style>` +
    `</head>` +
    `<body style="margin:0;padding:0;background:#F2EADD">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2EADD" style="background:#F2EADD;margin:0;padding:30px 12px">` +
     `<tr><td align="center">` +
      `<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:520px;background:#fffdf8;border:1px solid #e3dac6;border-radius:16px;overflow:hidden">` +
        // masthead — Schadow name on cream, thin rule, three services (the business-card look)
        `<tr><td align="center" style="padding:34px 30px 4px">` +
          `<img src="https://brochcustom.com/broch-email-logo.png" width="262" alt="BROCH CUSTOM" style="display:block;margin:0 auto;border:0;outline:none;height:auto;width:262px;max-width:78%;color:#1F4D3E;font-family:Georgia,serif;font-size:24px;font-weight:bold;letter-spacing:.1em">` +
          `<div style="width:120px;border-top:1px solid #cdbfa6;margin:16px auto 13px;font-size:0;line-height:0">&nbsp;</div>` +
          `<div style="font-family:${LABEL};font-size:13px;letter-spacing:.24em;color:#4A3424;text-transform:uppercase">Embroidery &middot; Printing &middot; Engraving</div>` +
        `</td></tr>` +
        // message
        `<tr><td style="padding:24px 34px 4px;font-family:${SERIF};color:#2c2620;font-size:16px;line-height:1.6">` +
          `<p style="margin:0 0 12px">${esc(hi)}</p>` +
          `<p style="margin:0 0 16px;font-family:${SERIF};font-size:24px;line-height:1.28;color:#1F4D3E;font-weight:600">${headlineHtml}</p>` +
          `<p style="margin:0 0 22px;color:#2c2620">${closing} Reply to this email with any questions.</p>` +
        `</td></tr>` +
        // contact panel (off-white, echoes the card)
        `<tr><td style="padding:0 34px 32px">` +
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAF6EE;border:1px solid #e8dfcd;border-radius:12px">` +
            `<tr><td style="padding:17px 20px;font-family:${SERIF};font-size:15px;line-height:1.75;color:#2c2620">` +
              `<div style="font-family:${LABEL};font-size:12px;letter-spacing:.2em;color:#4A3424;text-transform:uppercase;margin:0 0 8px">Get in touch</div>` +
              `<div>Call or text <a href="tel:9562255859" style="color:#1F4D3E;text-decoration:none">(956) 225-5859</a></div>` +
              `<div>Email <a href="mailto:brochcustom@gmail.com" style="color:#1F4D3E;text-decoration:none">brochcustom@gmail.com</a></div>` +
              `<div style="color:#4A3424">Broch Custom &middot; Edinburg, TX</div>` +
            `</td></tr>` +
          `</table>` +
        `</td></tr>` +
      `</table>` +
      // subtle brand footer under the card
      `<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:520px">` +
        `<tr><td style="padding:15px 8px 0;text-align:center;font-family:${LABEL};font-size:12px;letter-spacing:.18em;color:#9a8f78">` +
          `<a href="https://brochcustom.com" style="color:#9a8f78;text-decoration:none">BROCHCUSTOM.COM</a>` +
        `</td></tr>` +
      `</table>` +
     `</td></tr>` +
    `</table>` +
    `</body></html>`;

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
