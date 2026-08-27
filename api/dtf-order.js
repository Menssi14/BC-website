// Broch Custom — DTF production artwork self-email
// Lives at /api/dtf-order.js
//
// Sends production artwork FROM the configured Gmail account
// TO that same Gmail account. Nothing is saved to Supabase.
//
// Uses existing env vars:
//   GMAIL_USER
//   GMAIL_APP_PASSWORD

import nodemailer from 'nodemailer';

const MAX_FILE_BYTES = 3 * 1024 * 1024;

function cleanText(v, max = 200) {
  return String(v || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max)
    .trim();
}

function decodeArtwork(a) {
  const dataUrl = typeof a?.dataUrl === 'string' ? a.dataUrl : '';
  const match = dataUrl.match(
    /^data:(image\/png|image\/svg\+xml);base64,([A-Za-z0-9+/=\r\n]+)$/i
  );

  if (!match) throw new Error('PNG or SVG artwork is required.');

  const content = Buffer.from(match[2], 'base64');
  if (!content.length) throw new Error('Artwork could not be decoded.');
  if (content.length > MAX_FILE_BYTES) {
    throw new Error('Each artwork file must currently be 3 MB or smaller.');
  }

  const mime = match[1].toLowerCase();
  const ext = mime === 'image/svg+xml' ? '.svg' : '.png';

  let filename = cleanText(a.filename || ('dtf-artwork' + ext), 120)
    .replace(/[\\/:*?"<>|]+/g, '-');

  if (!filename.toLowerCase().endsWith(ext)) filename += ext;

  return {
    filename,
    attachment: {
      filename,
      content,
      contentType: mime
    },
    widthIn: Number(a.widthIn) || 0,
    heightIn: Number(a.heightIn) || 0,
    x: Number(a.x) || 0,
    y: Number(a.y) || 0,
    dpi: Number.isFinite(Number(a.dpi)) && Number(a.dpi) > 0
      ? Math.round(Number(a.dpi))
      : null,
    isVector: !!a.isVector,
    background: a.background || 'unknown'
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const MAIL_USER = process.env.GMAIL_USER;
  const MAIL_PASS = process.env.GMAIL_APP_PASSWORD;

  if (!MAIL_USER || !MAIL_PASS) {
    return res.status(500).json({ ok: false, error: 'Email is not configured.' });
  }

  const b = req.body || {};
  const ref = cleanText(b.reference || 'website order', 140);
  const status = cleanText(b.status || 'order', 40);
  const phone = cleanText(b.customerPhone, 30);
  const customerEmail = cleanText(b.customerEmail, 180);

  // New multi-design payload. A single artwork payload remains accepted
  // for backward compatibility with any older deployed store version.
  const sheet = b.sheet && Array.isArray(b.sheet.designs)
    ? b.sheet
    : {
        qty: b.artwork?.qty || 1,
        unitPrice: b.artwork?.unitPrice || 6,
        footprintW: b.artwork?.widthIn || 0,
        footprintH: b.artwork?.heightIn || 0,
        designs: b.artwork ? [b.artwork] : []
      };

  if (!sheet.designs.length) {
    return res.status(400).json({ ok: false, error: 'No DTF artwork was included.' });
  }

  let designs;
  try {
    designs = sheet.designs.map(decodeArtwork);
  } catch (e) {
    return res.status(413).json({
      ok: false,
      error: e.message || 'Could not read DTF artwork.'
    });
  }

  const qty = Math.max(1, Math.min(99, parseInt(sheet.qty, 10) || 1));
  const unitPrice = Number(sheet.unitPrice) === 5 ? 5 : 6;
  const footprintW = Number(sheet.footprintW) || 0;
  const footprintH = Number(sheet.footprintH) || 0;

  const designLines = [];
  designs.forEach((d, i) => {
    const backgroundText =
      d.background === 'background'
        ? 'BACKGROUND DETECTED — everything shown will print'
        : d.background === 'transparent'
          ? 'Transparency detected'
          : 'Background not confirmed';

    designLines.push(
      `Design ${i + 1}: ${d.filename}`,
      `  Size: ${d.widthIn.toFixed(2).replace(/\.00$/, '')}" × ${d.heightIn.toFixed(2).replace(/\.00$/, '')}"`,
      `  Position: X ${d.x.toFixed(2).replace(/\.00$/, '')}", Y ${d.y.toFixed(2).replace(/\.00$/, '')}"`,
      `  Quality: ${d.isVector ? 'Vector SVG' : (d.dpi ? d.dpi + ' DPI at selected size' : 'PNG')}`,
      `  Background: ${backgroundText}`,
      ''
    );
  });

  const details = [
    'BROCH CUSTOM — DTF PRODUCTION FILES',
    '',
    `Reference: ${ref}`,
    `Order status: ${status}`,
    phone ? `Customer phone: ${phone}` : '',
    customerEmail ? `Customer email: ${customerEmail}` : '',
    '',
    `Print amount: ${qty}`,
    `Price: $${unitPrice.toFixed(2)} each`,
    footprintW && footprintH
      ? `Used sheet area: ${footprintW.toFixed(2).replace(/\.00$/, '')}" × ${footprintH.toFixed(2).replace(/\.00$/, '')}"`
      : '',
    `Attached original files: ${designs.length}`,
    '',
    ...designLines,
    'These are the ORIGINAL PNG/SVG files uploaded by the customer.',
    'The artwork was emailed directly to the orders inbox and was not saved to Supabase.'
  ].filter(Boolean).join('\n');

  try {
    const mailer = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: MAIL_USER,
        pass: MAIL_PASS
      }
    });

    // Self-email: the website's configured orders Gmail sends the files to itself.
    await mailer.sendMail({
      from: `"Broch Custom Orders" <${MAIL_USER}>`,
      to: MAIL_USER,
      replyTo: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)
        ? customerEmail
        : undefined,
      subject: `🖨️ DTF ORDER FILES — ${ref}`,
      text: details,
      attachments: designs.map(d => d.attachment)
    });

    return res.status(200).json({
      ok: true,
      emailedTo: MAIL_USER,
      attachments: designs.length
    });
  } catch (e) {
    console.error('[dtf-order] self-email failed:', e);
    return res.status(500).json({
      ok: false,
      error: 'The order went through, but the DTF production email could not be sent.'
    });
  }
}
