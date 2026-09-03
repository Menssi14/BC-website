// lib/nas-art.js
//
// Moves order photos out of orders.json and onto the Synology NAS.
//
// The orders file used to carry every photo as text, which is what made the
// catalog file balloon to 29 MB. This uploads each photo to MinIO and hands
// back a short storage key like "_orders/art/o123-ab12.webp" to store instead.
//
// THIS MUST NEVER BREAK A PAYMENT. Every failure path — no credentials, NAS
// offline, slow network, bad image — returns the original data URL, so the
// caller stores it inline exactly as it did before. It never throws.
//
// Lives in lib/ rather than api/ so Vercel does not turn it into a route.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const PREFIX = '_orders/art/';
const MAX_IMAGES = 3;          // the order card shows at most three
const TOTAL_BUDGET_MS = 8000;  // give up and fall back rather than delay a charge

function client() {
  const endpoint = process.env.MINIO_ENDPOINT;
  const accessKeyId = process.env.MINIO_ACCESS_KEY;
  const secretAccessKey = process.env.MINIO_SECRET_KEY;
  const bucket = process.env.MINIO_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;

  return {
    bucket,
    s3: new S3Client({
      endpoint,
      region: process.env.MINIO_REGION || 'us-east-1',
      forcePathStyle:
        String(process.env.MINIO_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false',
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

function decode(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const head = dataUrl.slice(0, comma);
  if (!head.includes(';base64')) return null;
  const mime = (head.match(/data:([^;,]+)/) || [])[1] || 'application/octet-stream';
  let body;
  try {
    body = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  } catch {
    return null;
  }
  if (!body.length) return null;

  let ext = 'bin';
  if (mime.includes('webp')) ext = 'webp';
  else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
  else if (mime.includes('png')) ext = 'png';
  return { body, mime, ext };
}

function withTimeout(promise, ms) {
  let timer;
  const bail = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('storage timed out')), ms);
  });
  return Promise.race([promise, bail]).finally(() => clearTimeout(timer));
}

/**
 * Upload order photos to the NAS.
 *
 * @param   {string[]} images  data: URLs (anything else is passed through)
 * @param   {string}   idHint  the order id, used only to name the files
 * @returns {Promise<string[]>} storage keys where the upload worked, and the
 *                              original data URL where it did not
 */
export async function stashOrderImages(images, idHint) {
  const list = Array.isArray(images) ? images.slice(0, MAX_IMAGES) : [];
  if (!list.length) return [];

  const setup = client();
  if (!setup) return list;   // no NAS configured — behave exactly as before

  const started = Date.now();
  const safeId = String(idHint || 'order').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'order';

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const original = list[i];
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    const parsed = decode(original);

    if (!parsed || left < 500) {
      out.push(original);       // not an image we can move, or out of time
      continue;
    }

    const key =
      PREFIX + safeId + '-' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 6) + '.' + parsed.ext;

    try {
      await withTimeout(
        setup.s3.send(new PutObjectCommand({
          Bucket: setup.bucket,
          Key: key,
          Body: parsed.body,
          ContentType: parsed.mime,
        })),
        left
      );
      out.push(key);
    } catch (err) {
      // NAS unreachable, slow, or refusing — keep the photo inline.
      try { console.error('[nas-art] could not store photo, keeping it inline:', err && err.message); } catch (_) {}
      out.push(original);
    }
  }
  return out;
}
