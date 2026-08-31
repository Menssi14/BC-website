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

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function formatTransform(d) {
  const parts = [];
  const rot = ((((Number(d?.rotation) || 0) % 360) + 360) % 360);
  if (rot) parts.push(`Rotate ${rot}°`);
  if (d?.flipX) parts.push('Mirror H');
  if (d?.flipY) parts.push('Mirror V');
  return parts.join(' · ') || 'Standard';
}

function cleanText(v, max = 200) {
  return String(v || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max)
    .trim();
}

function decodeImagePayload(a, fallbackName = 'dtf-artwork.png') {
  const dataUrl = typeof a?.dataUrl === 'string' ? a.dataUrl : '';
  const match = dataUrl.match(
    /^data:(image\/png|image\/svg\+xml);base64,([A-Za-z0-9+/=\r\n]+)$/i
  );

  if (!match) throw new Error('PNG or SVG artwork is required.');

  const content = Buffer.from(match[2], 'base64');
  if (!content.length) throw new Error('Artwork could not be decoded.');
  if (content.length > MAX_FILE_BYTES) {
    throw new Error('Each artwork file must currently be 10 MB or smaller.');
  }

  const mime = match[1].toLowerCase();
  const ext = mime === 'image/svg+xml' ? '.svg' : '.png';

  let filename = cleanText(a.filename || fallbackName, 120)
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
    rotation: ((((Number(a.rotation) || 0) % 360) + 360) % 360),
    flipX: !!a.flipX,
    flipY: !!a.flipY,
    background: a.background || 'unknown'
  };
}

function decodePngAttachment(dataUrl, filename = 'dtf-gangsheet.png') {
  const match = String(dataUrl || '').match(
    /^data:(image\/png);base64,([A-Za-z0-9+/=\r\n]+)$/i
  );

  if (!match) throw new Error('Gangsheet PNG is required.');

  const content = Buffer.from(match[2], 'base64');
  if (!content.length) throw new Error('Gangsheet file could not be decoded.');
  if (content.length > MAX_FILE_BYTES) {
    throw new Error('The gangsheet file must currently be 10 MB or smaller.');
  }

  let safeName = cleanText(filename, 120).replace(/[\\/:*?"<>|]+/g, '-');
  if (!safeName.toLowerCase().endsWith('.png')) safeName += '.png';

  return {
    filename: safeName,
    content,
    contentType: 'image/png'
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
    designs = sheet.designs.map(d => decodeImagePayload(d, d?.filename || 'dtf-artwork.png'));
  } catch (e) {
    return res.status(413).json({
      ok: false,
      error: e.message || 'Could not read DTF artwork.'
    });
  }

  const qty = Math.max(1, Math.min(99, parseInt(sheet.qty, 10) || 1));
  const unitPrice = Math.max(0, Number(sheet.unitPrice) || 0);
  const footprintW = Number(sheet.footprintW) || 0;
  const footprintH = Number(sheet.footprintH) || 0;
  const mode = sheet.mode === 'gangsheet' || designs.length > 1 ? 'gangsheet' : 'single';

  const d = designs[0];
  const sizeText =
    `${d.widthIn.toFixed(2).replace(/\.00$/, '')}" × ${d.heightIn.toFixed(2).replace(/\.00$/, '')}"`;
  const sheetSizeText = footprintW > 0 && footprintH > 0
    ? `${footprintW.toFixed(2).replace(/\.00$/, '')}" × ${footprintH.toFixed(2).replace(/\.00$/, '')}"`
    : '';
  const total = unitPrice * qty;

  const lowDpiCount = designs.filter(x => !x.isVector && x.dpi && x.dpi < 150).length;
  const backgroundCount = designs.filter(x => x.background === 'background').length;
  const warningLines = [];
  if (lowDpiCount) warningLines.push(`⚠ Low resolution on ${lowDpiCount} design${lowDpiCount === 1 ? '' : 's'}`);
  if (backgroundCount) warningLines.push(`⚠ Background detected on ${backgroundCount} design${backgroundCount === 1 ? '' : 's'}`);

  let subject, details, attachments;

  try {
  if (mode === 'single') {
    subject = `DTF Order — ${sizeText} — Qty ${qty}`;
    details = [
      'New DTF Order',
      '',
      `Order: ${ref}`,
      `Size: ${sizeText}`,
      `Quantity: ${qty}`,
      `Transform: ${formatTransform(d)}`,
      `Price: $${unitPrice.toFixed(2)} each`,
      qty > 1 ? `Total: $${total.toFixed(2)}` : '',
      '',
      ...warningLines,
      warningLines.length ? '' : '',
      'Original artwork attached.'
    ].filter(Boolean).join('\n');

    attachments = [designs[0].attachment];
  } else {
    const gangsheetAttachment = decodePngAttachment(
      sheet.gangsheetFile,
      `dtf-gangsheet-${ref}.png`
    );

    subject = `DTF Gangsheet — ${sheetSizeText || '13" × 20"'} — Qty ${qty}`;
    details = [
      'New DTF Gangsheet Order',
      '',
      `Order: ${ref}`,
      sheetSizeText ? `Used area: ${sheetSizeText}` : '',
      `Designs: ${designs.length}`,
      `Quantity: ${qty}`,
      `Transformed: ${designs.filter(x => formatTransform(x) !== 'Standard').length}`,
      `Price: $${unitPrice.toFixed(2)} each`,
      qty > 1 ? `Total: $${total.toFixed(2)}` : '',
      '',
      ...warningLines,
      warningLines.length ? '' : '',
      'Gangsheet file attached.'
    ].filter(Boolean).join('\n');

    attachments = [gangsheetAttachment];
  }
  } catch (e) {
    return res.status(413).json({ ok: false, error: e.message || 'Could not read the artwork or gangsheet file.' });
  }

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
      subject,
      text: details,
      attachments
    });

    return res.status(200).json({
      ok: true,
      emailedTo: MAIL_USER,
      attachments: attachments.length
    });
  } catch (e) {
    console.error('[dtf-order] self-email failed:', e);
    return res.status(500).json({
      ok: false,
      error: 'The order went through, but the DTF production email could not be sent.'
    });
  }
}
