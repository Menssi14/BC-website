// api/minio-file.js
// Hands out short-lived, signed links so the browser can talk to MinIO directly
// without ever seeing the MinIO username or password.
//
// POST { action: "upload-url", key, contentType }  -> { ok, url, key, expiresIn }
// POST { action: "view-urls",  keys: [ ... ] }     -> { ok, urls: { key: url } }
// POST { action: "delete", key }                   -> { ok, key }
// POST { action: "list",    prefix }                -> { ok, files: [ {key,size,updated} ] }
//
// Uploads go browser -> MinIO directly, so Vercel's ~4.5MB request limit does
// not apply to the artwork itself.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const UPLOAD_TTL = 900;    // 15 minutes to finish an upload
const VIEW_TTL = 21600;    // 6 hours for a viewable image link
const MAX_KEYS_PER_CALL = 500;
const MAX_CLEANUP_KEYS = 20;
const CANDIDATE_PREFIXES = ['_designs/', '_store/art/', '_orders/art/'];
const HISTORY_PREFIX = '_history/deletions/';
const SUPABASE_URL = 'https://ixuxzdaevbytnznxmtal.supabase.co';
const SUPABASE_BUCKET = 'files';

// Only these prefixes may be written to, so a stray call cannot overwrite
// settings files or other people's folders.
const ALLOWED_PREFIXES = ['_catalog/', '_designs/', '_fonts/', '_share/', '_store/', '_orders/'];

function badKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > 512) return true;
  if (key.includes('..') || key.startsWith('/')) return true;
  return !ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

function makeClient() {
  const endpoint = process.env.MINIO_ENDPOINT;
  const accessKeyId = process.env.MINIO_ACCESS_KEY;
  const secretAccessKey = process.env.MINIO_SECRET_KEY;
  const bucket = process.env.MINIO_BUCKET;
  const region = process.env.MINIO_REGION || 'us-east-1';
  const forcePathStyle =
    String(process.env.MINIO_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false';

  const missing = [];
  if (!endpoint) missing.push('MINIO_ENDPOINT');
  if (!accessKeyId) missing.push('MINIO_ACCESS_KEY');
  if (!secretAccessKey) missing.push('MINIO_SECRET_KEY');
  if (!bucket) missing.push('MINIO_BUCKET');
  if (missing.length) return { missing };

  return {
    bucket,
    client: new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}


// Read the CURRENT Supabase records before releasing an uploaded image.
// This must fail CLOSED if the cloud is unavailable or a document cannot be parsed.
// We use the same read-only anon token already used by the frontends; a server-side
// SUPABASE_ANON_KEY environment variable is preferred if configured.
async function readCloud(path, token, required = false) {
  const uri = SUPABASE_URL + '/storage/v1/object/authenticated/' +
    SUPABASE_BUCKET + '/' + path.split('/').map(encodeURIComponent).join('/') +
    '?cleanupCheck=' + Date.now();
  const resp = await fetch(uri, { headers: {
    apikey: token, Authorization: 'Bearer ' + token,
    'Cache-Control': 'no-cache',
  }, signal: AbortSignal.timeout(8500) });
  if (!resp.ok) {
    // 404 is allowed only for OPTIONAL metadata that has never been created.
    if (resp.status === 404 && !required) return null;
    throw new Error('Could not verify ' + path + ' (' + resp.status + '). No files deleted.');
  }
  const txt = await resp.text();
  // Reject garbled or unexpected content rather than treating it as no references.
  const parsed = JSON.parse(txt);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid cloud manifest: ' + path);
  return { parsed, txt };
}

async function currentReferences(token) {
  if (!token || typeof token !== 'string' || token.length > 3000) {
    throw new Error('Supabase read token unavailable; cleanup skipped safely.');
  }
  const files = [
    ['_catalog/catalog.json', true],
    ['_store/products.json', true],
    ['_orders/orders.json', true],
    ['_store/collections.json', false],
    ['_store/utrgv.json', false],
    ['_store/collection-utrgv.json', false],
  ];
  const docs = [];
  for (const [path, required] of files) {
    const result = await readCloud(path, token, required);
    if (result) docs.push({ path, text: result.txt, value: result.parsed });
  }
  const coll = docs.find(d => d.path === '_store/collections.json');
  if (coll) {
    if (!Array.isArray(coll.value.collections)) throw new Error('Invalid collections list. No files deleted.');
    if (coll.value.collections.length > 100) throw new Error('Too many collections to check safely.');
    for (const c of coll.value.collections) {
      if (!c || typeof c.id !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(c.id)) {
        throw new Error('Invalid collection identifier; cleanup skipped.');
      }
      if (c.id === 'utrgv') continue;
      const path = '_store/collection-' + c.id + '.json';
      const result = await readCloud(path, token, true);
      docs.push({ path, text: result.txt, value: result.parsed });
    }
  }
  // Required document shapes: a successful but empty JSON object is NOT proof
  // that a file is no longer used.
  const catalog = docs.find(d => d.path === '_catalog/catalog.json');
  const products = docs.find(d => d.path === '_store/products.json');
  const orders = docs.find(d => d.path === '_orders/orders.json');
  if (!Array.isArray(catalog?.value.designs) || !Array.isArray(catalog?.value.folders) ||
      !Array.isArray(products?.value) || !Array.isArray(orders?.value.orders)) {
    throw new Error('Cloud manifests incomplete; cleanup skipped.');
  }
  return docs;
}

// Immutable, very small TXT events rather than a shared append-only file:
// two simultaneous serverless deletes cannot overwrite one another's history.
async function deleteWithHistory(client, bucket, key, reason) {
  let bytes = 0;
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    bytes = Number(head.ContentLength || 0);
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
      return { key, status: 'not-found', bytes: 0 };
    }
    throw err;
  }
  const when = new Date();
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 12);
  const logKey = HISTORY_PREFIX + when.toISOString().slice(0, 10) + '/' + stamp + '-' + rand + '.txt';
  const detail = 'Time UTC: ' + when.toISOString() + '\nReason: ' + reason +
    '\nFile key: ' + key + '\nPrevious size: ' + bytes + ' bytes\n';
  // Reserve a TXT audit record first. If history cannot be written (permissions,
  // NAS outage), do not delete the artwork and lose the audit trail.
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: logKey, Body: detail + 'Status: PENDING\n',
    ContentType: 'text/plain; charset=utf-8',
  }));
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: logKey, Body: detail + 'Status: DELETE FAILED\n',
        ContentType: 'text/plain; charset=utf-8',
      }));
    } catch (_) { /* the PENDING record still exists */ }
    throw err;
  }
  let historySaved = false;
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: logKey, Body: detail + 'Status: DELETED\n',
      ContentType: 'text/plain; charset=utf-8',
    }));
    historySaved = true;
  } catch (err) {
    console.error('[storage] Deleted, but could not finalize history:', key, err);
    // The PENDING record remains for an administrator to inspect.
  }

  return { key, status: 'deleted', bytes, historySaved };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST.' });
  }

  const setup = makeClient();
  if (setup.missing) {
    return res.status(500).json({
      ok: false,
      step: 'environment-variables',
      error: 'Missing required environment variables in Vercel.',
      missing: setup.missing,
    });
  }
  const { client, bucket } = setup;

  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: 'Body was not valid JSON.' });
  }

  const action = body && body.action;

  try {
    if (action === 'upload-url') {
      const key = body.key;
      if (badKey(key)) {
        return res.status(400).json({ ok: false, error: 'Bad or disallowed key.', key });
      }
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: body.contentType || 'application/octet-stream',
        }),
        { expiresIn: UPLOAD_TTL }
      );
      return res.status(200).json({ ok: true, url, key, expiresIn: UPLOAD_TTL });
    }

    if (action === 'view-urls') {
      const keys = Array.isArray(body.keys) ? body.keys : [];
      if (!keys.length) {
        return res.status(400).json({ ok: false, error: 'No keys given.' });
      }
      if (keys.length > MAX_KEYS_PER_CALL) {
        return res.status(400).json({
          ok: false,
          error: 'Too many keys in one call.',
          max: MAX_KEYS_PER_CALL,
          got: keys.length,
        });
      }
      const urls = {};
      const skipped = [];
      await Promise.all(
        keys.map(async (key) => {
          if (badKey(key)) { skipped.push(key); return; }
          urls[key] = await getSignedUrl(
            client,
            new GetObjectCommand({ Bucket: bucket, Key: key }),
            { expiresIn: VIEW_TTL }
          );
        })
      );
      return res.status(200).json({ ok: true, urls, skipped, expiresIn: VIEW_TTL });
    }

    if (action === 'list') {
      const prefix = typeof body.prefix === 'string' ? body.prefix : '';
      if (!prefix || !ALLOWED_PREFIXES.some((p) => prefix.startsWith(p))) {
        return res.status(400).json({ ok: false, error: 'Disallowed prefix.', prefix });
      }
      const files = [];
      let token;
      do {
        const out = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1000,
            ContinuationToken: token,
          })
        );
        (out.Contents || []).forEach((o) => {
          files.push({
            key: o.Key,
            size: o.Size,
            updated: o.LastModified ? new Date(o.LastModified).getTime() : 0,
          });
        });
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token && files.length < 5000);

      files.sort((a, b) => b.updated - a.updated);
      return res.status(200).json({ ok: true, prefix, files });
    }

    if (action === 'delete') {
      const key = body.key;
      if (badKey(key)) {
        return res.status(400).json({ ok: false, error: 'Bad or disallowed key.', key });
      }
      // Direct deletes are for standalone shared files and fonts only.
      // Artwork needs the reference check below.
      if (!['_share/', '_fonts/'].some(p => key.startsWith(p))) {
        return res.status(403).json({ ok: false, error: 'Artwork requires cleanup-unused reference verification.' });
      }
      const result = await deleteWithHistory(client, bucket, key, 'manual removal');
      return res.status(200).json({ ok: true, ...result });
    }

    if (action === 'storage-stats') {
      // Read-only count of CURRENT objects. Older versions and Synology
      // snapshots may occupy additional space not included in this figure.
      let token;
      let files = 0, bytes = 0, more = false;
      do {
        const out = await client.send(new ListObjectsV2Command({
          Bucket: bucket, MaxKeys: 1000, ContinuationToken: token,
        }));
        for (const item of out.Contents || []) {
          files++;
          bytes += Number(item.Size || 0);
        }
        more = Boolean(out.IsTruncated);
        token = more ? out.NextContinuationToken : undefined;
      } while (more && token && files < 50000);
      return res.status(200).json({ ok: true, files, bytes,
        complete: !more, excludesVersionsAndSnapshots: true });
    }

    if (action === 'cleanup-unused') {
      const keys = Array.isArray(body.keys) ? [...new Set(body.keys)] : [];
      if (!keys.length || keys.length > MAX_CLEANUP_KEYS ||
          keys.some(k => badKey(k) || !CANDIDATE_PREFIXES.some(p => k.startsWith(p)))) {
        return res.status(400).json({ ok: false, error: 'Invalid cleanup keys (max 20).' });
      }
      let refs;
      try {
        refs = await currentReferences(process.env.SUPABASE_ANON_KEY || body.supabaseKey);
      } catch (err) {
        // Fail closed: NEVER assume a file is orphaned during a cloud outage.
        return res.status(503).json({ ok: false, error: 'Reference check failed; nothing deleted.', message: err.message });
      }
      const results = [];
      for (const key of keys) {
        // A conservative text search also counts legacy references anywhere in
        // the metadata (including storefront collections and saved order data).
        const found = refs.find(doc => doc.text.includes(key));
        if (found) {
          results.push({ key, status: 'in-use', source: found.path });
          continue;
        }
        try {
          results.push(await deleteWithHistory(client, bucket, key, 'unreferenced artwork cleanup'));
        } catch (err) {
          results.push({ key, status: 'error', message: err.message || String(err) });
        }
      }
      return res.status(200).json({ ok: true, results });
    }

    return res.status(400).json({
      ok: false,
      error: 'Unknown action.',
      allowed: ['upload-url', 'view-urls', 'list', 'delete', 'cleanup-unused', 'storage-stats'],
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      step: action || 'unknown',
      error: err && err.name ? err.name : 'UnknownError',
      message: err && err.message ? err.message : String(err),
    });
  }
}
