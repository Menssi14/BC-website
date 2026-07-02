// ============================================================
//  Broch Custom — Live shipping rates (Vercel Function)
//  Lives at /api/shipping. The store's checkout sends the
//  customer's address + total order weight; this asks EasyPost
//  for real USPS rates and returns the cheapest one.
//
//  SETUP (one time):
//  1. Create a free account at easypost.com
//  2. Dashboard → API Keys → copy the PRODUCTION key
//  3. Vercel → Settings → Environment Variables →
//        EASYPOST_API_KEY = (paste the key)
//     Then REDEPLOY.
//
//  The shop's origin ZIP is set below — confirm it's right.
// ============================================================

const SHOP_ORIGIN = { city: 'Edinburg', state: 'TX', zip: '78539', country: 'US' };
const RATE_MARKUP = 0.00; // dollars added on top of the carrier rate (e.g. 1.00 to cover the box)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  const { street, city, state, zip, weightLb } = req.body || {};
  if (!zip || !/^\d{5}$/.test(String(zip)) || !(weightLb > 0)) {
    return res.status(400).json({ ok: false, error: 'Invalid address or weight.' });
  }
  if (!process.env.EASYPOST_API_KEY) {
    return res.status(500).json({ ok: false, error: 'Shipping service not configured.' });
  }

  try {
    const auth = 'Basic ' + Buffer.from(process.env.EASYPOST_API_KEY + ':').toString('base64');
    const r = await fetch('https://api.easypost.com/v2/shipments', {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shipment: {
          from_address: SHOP_ORIGIN,
          to_address: {
            street1: String(street || '').slice(0, 100),
            city: String(city || '').slice(0, 50),
            state: String(state || '').slice(0, 20),
            zip: String(zip),
            country: 'US'
          },
          parcel: { weight: Math.max(1, Math.round(weightLb * 16)) } // ounces
        }
      })
    });
    const data = await r.json();
    if (!r.ok || !data.rates || !data.rates.length) {
      const msg = (data.error && data.error.message) || 'No rates available for this address.';
      return res.status(422).json({ ok: false, error: msg });
    }
    // Cheapest USPS rate (fall back to cheapest overall if USPS missing)
    const usps = data.rates.filter(x => x.carrier === 'USPS');
    const pool = usps.length ? usps : data.rates;
    const best = pool.reduce((a, b) => parseFloat(a.rate) <= parseFloat(b.rate) ? a : b);
    const amount = Math.round((parseFloat(best.rate) + RATE_MARKUP) * 100) / 100;
    return res.status(200).json({
      ok: true,
      amount,
      carrier: best.carrier,
      service: best.service,
      days: best.delivery_days || null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Shipping service unavailable.' });
  }
}
