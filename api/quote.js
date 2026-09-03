// ============================================================
//  Broch Custom — Quote intake (Vercel Function)
//  This file lives at  api/quote.js  — a NEW file. It does NOT
//  touch api/pay.js or anything about payments.
//
//  What it does with every quote request:
//    1. Saves the customer's artwork (full quality) into the
//       File tab of the Tools app — same place your own
//       uploads live, named  {time}_QUOTE_{name}_{file}.
//    2. Drops a quote card into the Orders app (same Supabase
//       file the orders app reads, appended safely).
//    3. Emails the shop (GMAIL_USER) a heads-up.
//
//  Uses the SAME environment variables pay.js already uses:
//    SUPABASE_URL, SUPABASE_KEY, GMAIL_USER, GMAIL_APP_PASSWORD
//  Nothing new to configure. Just upload this file to /api.
// ============================================================

import nodemailer from 'nodemailer';

import { stashOrderImages } from '../lib/nas-art.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const b = req.body || {};
  const name    = String(b.name || '').slice(0, 120).trim();
  const phone   = String(b.phone || '').replace(/\D/g, '').slice(-10);
  const email   = (b.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) ? String(b.email).slice(0, 200) : '';
  const message = String(b.message || '').slice(0, 3000).trim();
  const details = String(b.details || '').slice(0, 2000).trim();   // e.g. shirt size/color from the builder
  const source  = (b.source === 'store') ? 'store' : 'homepage';

  // artwork: { filename, dataUrl } — full quality, goes to the email only
  // preview: a small dataUrl image — goes on the order card only
  // NOTE: never .slice() the dataUrl — a truncated base64 image saves as a
  // CORRUPTED file. Too big (shouldn't happen; the store caps uploads at 3 MB)
  // → drop the artwork and say so on the order card, keep the quote itself.
  const rawArt = (b.artwork && typeof b.artwork.dataUrl === 'string' && b.artwork.dataUrl.startsWith('data:')) ? b.artwork : null;
  const art = (rawArt && rawArt.dataUrl.length <= 4200000)
    ? { filename: String(rawArt.filename || 'artwork').slice(0, 120), dataUrl: rawArt.dataUrl }
    : null;
  const artTooBig = !!(rawArt && !art);
  const preview = (typeof b.preview === 'string' && b.preview.startsWith('data:image')) ? b.preview.slice(0, 400000) : '';

  // A quote needs at least a way to reach the person and something to quote
  if (!name && !phone && !email) {
    return res.status(400).json({ ok: false, error: 'Please include a name and a phone number or email.' });
  }
  if (!phone && !email) {
    return res.status(400).json({ ok: false, error: 'Please include a phone number or an email so we can reach you.' });
  }

  const now = Date.now();
  const phonePretty = phone ? '(' + phone.slice(0, 3) + ') ' + phone.slice(3, 6) + '-' + phone.slice(6) : '';

  const lines = [];
  lines.push(source === 'store' ? '🎨 QUOTE — customer artwork from the shop' : '💬 QUOTE — from the website');
  lines.push('');
  if (name)        lines.push('👤 ' + name);
  if (phonePretty) lines.push('📞 ' + phonePretty);
  if (email)       lines.push('✉️ ' + email);
  lines.push('');
  if (details) { lines.push('— What they built —'); lines.push(details); lines.push(''); }
  if (message) { lines.push('— Their message —'); lines.push(message); lines.push(''); }
  // (filled in below once we know where the artwork landed)
  const body = lines.join('\n');

  let logged = false, mailed = false, artFileName = '';

  // ── 1) Customer artwork → the File tab of the Tools app ──
  // The File tab lists everything at the top of the "files" storage
  // (and hides names that start with "_"), so a plain upload there
  // makes the artwork appear in the app with download + share buttons.
  try {
    const SB = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_KEY;
    if (SB && KEY && art) {
      const m = art.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        const safeName = (name || 'customer').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'customer';
        const safeFile = art.filename.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(0, 80) || 'artwork';
        artFileName = now + '_QUOTE_' + safeName + '_' + safeFile;
        const up = await fetch(`${SB}/storage/v1/object/files/${encodeURIComponent(artFileName)}`, {
          method: 'POST',
          headers: {
            'apikey': KEY, 'Authorization': `Bearer ${KEY}`,
            'Content-Type': m[1], 'x-upsert': 'true'
          },
          body: Buffer.from(m[2], 'base64')
        });
        if (!up.ok) artFileName = '';
      }
    }
  } catch (e) {
    console.error('[quote] could not store artwork:', e);
    artFileName = '';
  }
  if (artFileName) lines.push('📎 Artwork saved to the File tab: ' + artFileName);
  else if (art) lines.push('⚠️ Artwork upload failed — ask the customer to text it to you.');
  else if (artTooBig) lines.push('⚠️ Their artwork file was too large to come through — ask them to text it to you.');
  const body2 = lines.join('\n');

  // ── 2) Drop the quote onto the Orders app ──
  try {
    const SB = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_KEY;
    if (SB && KEY) {
      const FILE = '_orders/orders.json';
      const base = `${SB}/storage/v1/object/files/${FILE}`;
      const hdr = { 'apikey': KEY, 'Authorization': `Bearer ${KEY}` };

      let store = { v: 10, orders: [] };
      try {
        const cur = await fetch(base, { headers: hdr });
        if (cur.ok) {
          const parsed = await cur.json();
          if (parsed && Array.isArray(parsed.orders)) store = parsed;
        }
      } catch (_) { /* file may not exist yet */ }

      const quoteId = 'q' + now.toString(36) + Math.random().toString(36).slice(2, 6);
      // Same as paid orders: the preview goes to the NAS, the quote keeps a
      // reference. Falls back to storing it inline if the NAS is unreachable.
      const quoteImages = await stashOrderImages(preview ? [preview] : [], quoteId);

      store.orders.push({
        id: quoteId,
        type: 'NOTE',
        isQuote: true,
        title: '💬 Quote' + (name ? ' · ' + name : (phonePretty ? ' · ' + phonePretty : '')),
        custName: name || 'Quote request',
        custPhone: phone,
        custEmail: email,
        contact: phone,
        body: body2,
        urgency: 'norush',   // must be a real urgency key — blank crashed older card code
        designReady: false,
        stage: 'New',
        payStatus: '',
        payLocked: false,
        balanceDue: '',
        fulfillment: 'pickup',
        items: [],
        images: quoteImages,
        due: '', duePreset: '',
        trashed: false, trashedAt: null,
        source: 'quote',
        createdAt: now, updatedAt: now
      });

      const up = await fetch(base, {
        method: 'POST',
        headers: { ...hdr, 'Content-Type': 'application/json', 'x-upsert': 'true' },
        body: JSON.stringify(store)
      });
      logged = up.ok;
    }
  } catch (e) {
    console.error('[quote] could not log:', e);
  }

  // ── 3) Email the shop a heads-up ──
  try {
    const MAIL_USER = process.env.GMAIL_USER;
    const MAIL_PASS = process.env.GMAIL_APP_PASSWORD;
    if (MAIL_USER && MAIL_PASS) {
      const mailer = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: MAIL_USER, pass: MAIL_PASS }
      });

      await mailer.sendMail({
        from: `"Broch Custom" <${MAIL_USER}>`,
        to: MAIL_USER,
        subject: (source === 'store' ? '🎨 Quote with artwork' : '💬 New quote request') + (name ? ' — ' + name : ''),
        text: body2 + '\n\nThis quote is on your Orders app under the 💬 button' + (artFileName ? ', and the artwork is in the File tab of the Tools app.' : '.')
      });
      mailed = true;
    }
  } catch (e) {
    console.error('[quote] could not email:', e);
  }

  if (!logged && !mailed) {
    return res.status(500).json({ ok: false, error: "We couldn't send that right now — please call or text us at (956) 225-5859." });
  }
  return res.status(200).json({ ok: true });
}
