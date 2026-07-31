// ============================================================
//  Broch Custom — customer notification emails (Vercel Function)
//  Lives at  api/notify.js  — does NOT touch pay.js / payments.
//
//  The Orders app calls this with a customer email + a "kind":
//    paid      → Payment received
//    pending   → Payment pending
//    ready     → Order ready for pickup
//    delivery  → Order out for delivery
//    custom    → a blank/custom message you type yourself
//                (pass: subject, heading, message)
//
//  Fixed kinds send set wording. "custom" lets you send your own
//  text in the same design. All text is escaped, so nothing can be
//  injected. If you expose the endpoint, you can require a secret:
//  set env NOTIFY_SECRET and have the app send { secret } with
//  custom sends (only enforced when NOTIFY_SECRET is set).
//
//  Uses the SAME env vars pay.js uses: GMAIL_USER, GMAIL_APP_PASSWORD
// ============================================================

import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const b = req.body || {};
  const email = (b.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) ? String(b.email).slice(0, 200) : '';
  const name  = String(b.name || '').slice(0, 120).trim();

  const VALID = ['paid', 'pending', 'ready', 'delivery', 'custom'];
  const kind  = VALID.includes(b.kind) ? b.kind : 'ready';

  if (!email) return res.status(400).json({ ok: false, error: 'No customer email on this order.' });

  const MAIL_USER = process.env.GMAIL_USER;
  const MAIL_PASS = process.env.GMAIL_APP_PASSWORD;
  if (!MAIL_USER || !MAIL_PASS) {
    return res.status(500).json({ ok: false, error: 'Email is not configured.' });
  }

  // Optional protection for the custom sender (only enforced if you set NOTIFY_SECRET)
  const SECRET = process.env.NOTIFY_SECRET || '';
  if (kind === 'custom' && SECRET && String(b.secret || '') !== SECRET) {
    return res.status(403).json({ ok: false, error: 'Not authorized to send a custom message.' });
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const hi  = name ? 'Hi ' + name + ',' : 'Hi,';

  // Fixed messages
  const M = {
    paid:     { subject: 'Payment received — Broch Custom',              heading: 'We received your payment — thank you!', body: "We're getting started on your order." },
    pending:  { subject: 'Payment pending — Broch Custom',               heading: 'Your payment is pending',               body: "We'll email you as soon as it clears." },
    ready:    { subject: 'Your order is ready for pickup — Broch Custom', heading: 'Your order is ready for pickup!',        body: 'See you soon!' },
    delivery: { subject: 'Your order is out for delivery — Broch Custom', heading: 'Your order is out for delivery!',        body: "It's on the way to you." }
  };

  let subject, headingText, bodyText;
  if (kind === 'custom') {
    subject     = String(b.subject || '').slice(0, 160).trim() || 'A message from Broch Custom';
    headingText = String(b.heading || '').slice(0, 160).trim();
    bodyText    = String(b.message || '').slice(0, 2000);
    if (!headingText && !bodyText.trim()) {
      return res.status(400).json({ ok: false, error: 'Nothing to send — add a subject line or a message.' });
    }
  } else {
    const m = M[kind];
    subject = m.subject; headingText = m.heading; bodyText = m.body;
  }

  const headlineHtml = headingText ? esc(headingText) : '';
  const bodyHtml     = bodyText    ? esc(bodyText).replace(/\n/g, '<br>') : '';

  const text = [
    hi, '', headingText, '', bodyText, '',
    'Broch Custom · Edinburg, TX',
    'Call or text: (956) 225-5859',
    'Email: brochcustom@gmail.com',
    '', 'brochcustom.com'
  ].join('\n');

  // Brand fonts (EB Garamond + Teko) load in clients that support web fonts (e.g. Apple Mail);
  // elsewhere they fall back to Georgia / Arial. The Schadow logo is an image (with a styled
  // text fallback if images are blocked).
  const SERIF = "'EB Garamond', Georgia, 'Times New Roman', serif";
  const LABEL = "'Teko', 'Arial Narrow', Arial, sans-serif";

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">` +
    `<style>@import url('https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Teko:wght@400;500&display=swap');body{margin:0;padding:0}</style>` +
    `</head>` +
    `<body style="margin:0;padding:0;background:#F2EADD">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2EADD" style="background:#F2EADD;margin:0;padding:18px 12px">` +
     `<tr><td align="center">` +
      `<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:520px;background:#fffdf8;border:1px solid #e3dac6;border-radius:14px;overflow:hidden">` +
        // masthead — Schadow name on cream + thin rule (compact)
        `<tr><td align="center" style="padding:22px 26px 0">` +
          `<img src="https://brochcustom.com/broch-email-logo.png" width="204" alt="BROCH CUSTOM" style="display:block;margin:0 auto;border:0;outline:none;height:auto;width:204px;max-width:62%;color:#1F4D3E;font-family:Georgia,serif;font-size:20px;font-weight:bold;letter-spacing:.08em">` +
          `<div style="width:110px;border-top:1px solid #cdbfa6;margin:14px auto 0;font-size:0;line-height:0">&nbsp;</div>` +
        `</td></tr>` +
        // message (compact)
        `<tr><td style="padding:16px 28px 4px;font-family:${SERIF};color:#2c2620;font-size:15px;line-height:1.5">` +
          `<p style="margin:0 0 8px">${esc(hi)}</p>` +
          (headlineHtml ? `<p style="margin:0 0 ${bodyHtml ? '10px' : '0'};font-family:${SERIF};font-size:22px;line-height:1.22;color:#1F4D3E;font-weight:600">${headlineHtml}</p>` : '') +
          (bodyHtml ? `<p style="margin:0;color:#2c2620">${bodyHtml}</p>` : '') +
        `</td></tr>` +
        // contact panel (compact)
        `<tr><td style="padding:14px 28px 22px">` +
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAF6EE;border:1px solid #e8dfcd;border-radius:10px">` +
            `<tr><td style="padding:12px 16px;font-family:${SERIF};font-size:14px;line-height:1.55;color:#2c2620">` +
              `<div style="font-family:${LABEL};font-size:11px;letter-spacing:.18em;color:#4A3424;text-transform:uppercase;margin:0 0 5px">Get in touch</div>` +
              `<div>Call or text <a href="tel:9562255859" style="color:#1F4D3E;text-decoration:none">(956) 225-5859</a></div>` +
              `<div>Email <a href="mailto:brochcustom@gmail.com" style="color:#1F4D3E;text-decoration:none">brochcustom@gmail.com</a></div>` +
              `<div style="color:#4A3424">Edinburg, TX</div>` +
            `</td></tr>` +
          `</table>` +
        `</td></tr>` +
      `</table>` +
      // subtle brand footer
      `<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:520px">` +
        `<tr><td style="padding:12px 8px 0;text-align:center;font-family:${LABEL};font-size:12px;letter-spacing:.18em;color:#9a8f78">` +
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
      subject,
      text, html
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[notify] send failed:', e);
    return res.status(500).json({ ok: false, error: 'Could not send the email.' });
  }
}
