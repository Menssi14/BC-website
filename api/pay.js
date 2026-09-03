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
//        GMAIL_USER            = the shop Gmail address (for confirmations)
//        GMAIL_APP_PASSWORD    = a Gmail app password
//     NEVER paste the token into any other file.
//  3. Deploy. The website's PAYMENT_ENDPOINT ('/api/pay') will reach this.
// ============================================================

import nodemailer from 'nodemailer';
import { randomUUID } from 'crypto';

function websiteOrderType(items, hasDtf) {
  const text = String(items || '');

  // DTF Builder orders get their own DTF tag.
  if (hasDtf || /\bDTF\b/i.test(text)) return 'DTF';

  // Uniform Builder / embroidered products.
  const embroidered = /embroider(?:ed|y|ing)?|left chest embroidery|right chest name/i.test(text);

  // Shirt Builder / products explicitly named as printed.
  const printed = /\bcustom shirt\b|\bprinted\b|\bprinting\b|\bprint shirt\b/i.test(text);

  if (embroidered && printed) return 'MIXED';
  if (embroidered) return 'EMBROIDERED';
  if (printed) return 'PRINTED';

  return 'NOTE';
}

import { stashOrderImages } from '../lib/nas-art.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { sourceId, amountCents, email, phone, items, fulfillment, shippingCents, address, mockups, hasDtf } = req.body || {};

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
    idempotency_key: randomUUID(),     // prevents accidental double-charges
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
      // Details shared by the order log and the confirmation emails
      const now = Date.now();
      const phone10 = phone ? phone.slice(-10) : '';
      const phonePretty = phone10
        ? '(' + phone10.slice(0,3) + ') ' + phone10.slice(3,6) + '-' + phone10.slice(6)
        : '';
      const custEmail = (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) ? email : '';
      const paidStr = '$' + (amountCents / 100).toFixed(2);
      const receiptUrl = data.payment.receipt_url || '';
      const isShip = (fulfillment === 'ship');
      // Build a clean, readable note
      const lines = [];
      lines.push('🛒 ONLINE ORDER');
      lines.push('');
      if (phonePretty) lines.push('📞 ' + phonePretty);
      if (custEmail)   lines.push('✉️ ' + custEmail);
      lines.push('');
      if (items) { lines.push('— Items —'); lines.push(String(items).slice(0, 2000)); lines.push(''); }
      if (isShip) {
        lines.push('📦 SHIP TO: ' + String(address || 'address missing').slice(0, 300));
        lines.push('🚚 Shipping: ' + (shippingCents > 0 ? '$' + (shippingCents / 100).toFixed(2) : 'FREE'));
      } else {
        lines.push('🌲 Pickup at shop');
      }
      lines.push('');
      lines.push('💵 Paid: ' + paidStr);
      if (data.payment.receipt_number) lines.push('🧾 Receipt ' + data.payment.receipt_number);
      const niceBody = lines.join('\n');

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

          const orderId = 'o' + now.toString(36) + Math.random().toString(36).slice(2, 6);
          // Photos go to the NAS; the order keeps a short reference. If the NAS
          // is unreachable this hands back the original images and they are
          // stored inline exactly as before — it never throws.
          const orderImages = await stashOrderImages(
            Array.isArray(mockups) ? mockups.slice(0, 3) : [], orderId);

          store.orders.push({
            id: orderId,
            type: websiteOrderType(items, hasDtf),
            title: (isShip ? '📦 ' : '') + 'Website order' + (phonePretty ? ' · ' + phonePretty : ''),
            custName: 'Website order' + (phonePretty ? ' · ' + phonePretty : ''),
            custPhone: phone10,
            custEmail: custEmail,
            contact: phone10,
            body: niceBody,
            urgency: 'asap',
            designReady: false,
            stage: 'New',
            payStatus: 'paid',
            payLocked: true,
            balanceDue: '',
            fulfillment: fulfillment || 'pickup',
            items: [],
            images: orderImages,   // shirt-builder mockups → the order card
            due: '', duePreset: '',
            trashed: false, trashedAt: null,
            source: 'online',
            paidCents: amountCents,
            paymentId: data.payment.id,
            receipt: data.payment.receipt_number || '',
            customerEmail: custEmail,
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

      // ── Email confirmations (never blocks the charge) ──
      // Sends through the shop's Gmail using an app password.
      // Needs GMAIL_USER + GMAIL_APP_PASSWORD in Vercel env vars.
      // If anything here fails, the PAYMENT STILL SUCCEEDS.
      try {
        const MAIL_USER = process.env.GMAIL_USER;
        const MAIL_PASS = process.env.GMAIL_APP_PASSWORD;
        if (MAIL_USER && MAIL_PASS) {
          const mailer = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: MAIL_USER, pass: MAIL_PASS }
          });

          // 1) heads-up to the shop on every paid order
          await mailer.sendMail({
            from: `"Broch Custom" <${MAIL_USER}>`,
            to: MAIL_USER,
            subject: `🛒 New online order — ${paidStr}`,
            text: niceBody
          });

          // 2) confirmation to the buyer, if they gave an email
          if (custEmail) {
            const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const itemsBlock = items ? String(items).slice(0, 2000) : '';

            const textLines = ['Thanks for your order with Broch Custom!', ''];
            if (itemsBlock) { textLines.push('— Items —', itemsBlock, ''); }
            if (isShip) {
              textLines.push('Shipping to: ' + String(address || '').slice(0, 300));
              textLines.push('Shipping: ' + (shippingCents > 0 ? '$' + (shippingCents / 100).toFixed(2) : 'FREE'), '');
            } else {
              textLines.push('Pickup at the shop.', '');
            }
            textLines.push('Paid: ' + paidStr);
            if (receiptUrl) textLines.push('Receipt: ' + receiptUrl);
            textLines.push('', "We'll be in touch about pickup or delivery. Reply to this email with any questions.");

            const html =
              `<div style="font-family:Georgia,'Times New Roman',serif;background:#F2EADD;padding:26px 16px">` +
                `<div style="max-width:520px;margin:0 auto;background:#fffdf8;border:1px solid #e3dac6;border-radius:10px;overflow:hidden">` +
                  `<div style="background:#1F4D3E;padding:18px 22px"><img src="https://brochcustom.com/broch-email-logo.png" width="216" alt="BROCH CUSTOM" style="display:block;border:0;height:auto;max-width:72%;color:#F2EADD;font-size:19px;letter-spacing:.08em"></div>` +
                  `<div style="padding:22px;color:#2c2620;font-size:15px;line-height:1.5">` +
                    `<p style="margin:0 0 12px">Thanks for your order! Here's what we got:</p>` +
                    (itemsBlock ? `<pre style="font-family:inherit;white-space:pre-wrap;background:#f4eede;padding:12px 14px;border-radius:6px;margin:0 0 14px">${esc(itemsBlock)}</pre>` : '') +
                    (isShip
                      ? `<p style="margin:0 0 14px;color:#4A3424">📦 Shipping to: ${esc(String(address || '').slice(0,300))}<br>🚚 ${shippingCents > 0 ? '$' + (shippingCents/100).toFixed(2) : 'FREE'}</p>`
                      : `<p style="margin:0 0 14px;color:#4A3424">🌲 Pickup at the shop.</p>`) +
                    `<p style="margin:0 0 6px"><strong>Paid: ${paidStr}</strong></p>` +
                    (receiptUrl ? `<p style="margin:0 0 14px"><a href="${receiptUrl}" style="color:#1F4D3E">View your Square receipt</a></p>` : '') +
                    `<p style="margin:0;color:#4A3424">We'll be in touch about pickup or delivery. Reply to this email with any questions.</p>` +
                  `</div>` +
                `</div>` +
              `</div>`;

            await mailer.sendMail({
              from: `"Broch Custom" <${MAIL_USER}>`,
              to: custEmail,
              subject: 'Order confirmed — Broch Custom',
              text: textLines.join('\n'),
              html
            });
          }
        }
      } catch (mailErr) {
        console.error('[email] could not send confirmation:', mailErr);
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
