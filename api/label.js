// ============================================================
//  Broch Custom — Shipping labels (Vercel Function)
//  Lives at  api/label.js
//
//  TWO STEPS, on purpose — buying postage spends real money:
//    { action:'rate', to:{...}, parcel:{...} }  → returns the options + prices
//    { action:'buy',  shipmentId, rateId }      → buys THAT rate, returns the label
//
//  Uses the same EASYPOST_API_KEY the rate quoter already uses.
//  A test key (EZTK…) makes fake labels — safe for practice.
//  A production key (EZAK…) buys real postage and charges your
//  EasyPost balance.
// ============================================================

const SHOP_FROM = {
  name: 'Broch Custom',
  street1: '', // optional — EasyPost accepts city/state/zip alone for most rates
  city: 'Edinburg',
  state: 'TX',
  zip: '78539',
  country: 'US',
  phone: '9562255859'
};

const timed = (p, ms = 12000) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  const KEY = process.env.EASYPOST_API_KEY;
  if (!KEY) return res.status(500).json({ ok: false, error: 'Shipping is not set up yet.' });

  const auth = 'Basic ' + Buffer.from(KEY + ':').toString('base64');
  const headers = { 'Authorization': auth, 'Content-Type': 'application/json' };
  const body = req.body || {};

  try {
    // ── STEP 1: create the shipment and hand back the price options ──
    if (body.action === 'rate') {
      const t = body.to || {}, p = body.parcel || {};
      if (!t.zip || !/^\d{5}$/.test(String(t.zip))) {
        return res.status(400).json({ ok: false, error: 'A 5-digit ZIP is required.' });
      }
      const ounces = Number(p.ounces);
      if (!(ounces > 0)) return res.status(400).json({ ok: false, error: 'Weight is required.' });

      const parcel = { weight: Math.max(1, Math.round(ounces)) };
      if (p.length && p.width && p.height) {
        parcel.length = Number(p.length);
        parcel.width = Number(p.width);
        parcel.height = Number(p.height);
      }

      const r = await timed(fetch('https://api.easypost.com/v2/shipments', {
        method: 'POST', headers,
        body: JSON.stringify({
          shipment: {
            from_address: SHOP_FROM,
            to_address: {
              name: String(t.name || '').slice(0, 80),
              street1: String(t.street || '').slice(0, 100),
              street2: String(t.street2 || '').slice(0, 100),
              city: String(t.city || '').slice(0, 50),
              state: String(t.state || '').slice(0, 20),
              zip: String(t.zip),
              country: 'US',
              phone: String(t.phone || '').replace(/\D/g, '').slice(-10)
            },
            parcel
          }
        })
      }));
      const data = await r.json();
      if (!r.ok || !data.rates || !data.rates.length) {
        const msg = (data.error && data.error.message) || 'No rates for that address.';
        return res.status(422).json({ ok: false, error: msg });
      }
      // cheapest first, USPS preferred
      const rates = data.rates
        .map(x => ({
          id: x.id,
          carrier: x.carrier,
          service: x.service,
          price: Number(x.rate),
          days: x.delivery_days || null
        }))
        .sort((a, b) => a.price - b.price)
        .slice(0, 6);

      return res.status(200).json({ ok: true, shipmentId: data.id, rates });
    }

    // ── ADDRESS CHECK: is this a real, deliverable address? ──
    //  Send whatever the user typed; USPS's database fills in the rest
    //  (city and state come back from the ZIP) and corrects the street.
    if (body.action === 'verify') {
      const t = body.to || {};
      if (!t.zip && !t.city) {
        return res.status(400).json({ ok: false, error: 'Enter a ZIP or a city first.' });
      }
      const r = await timed(fetch('https://api.easypost.com/v2/addresses/create_and_verify', {
        method: 'POST', headers,
        body: JSON.stringify({
          address: {
            street1: String(t.street || '').slice(0, 100),
            street2: String(t.street2 || '').slice(0, 100),
            city: String(t.city || '').slice(0, 50),
            state: String(t.state || '').slice(0, 20),
            zip: String(t.zip || '').slice(0, 10),
            country: 'US'
          }
        })
      }));
      const data = await r.json();
      const a = data && (data.address || data);
      if (!r.ok || !a || !a.zip) {
        const msg = (data && data.error && data.error.message) || 'That address could not be found.';
        return res.status(422).json({ ok: false, error: msg });
      }
      // EasyPost reports problems here even when it returns something
      let warning = '';
      try {
        const v = a.verifications && a.verifications.delivery;
        if (v && v.success === false) warning = (v.errors && v.errors[0] && v.errors[0].message) || 'Address may not be deliverable.';
        else if (v && v.details && v.details.dpv_confirmation === 'D') warning = 'Missing apartment or unit number.';
      } catch (_) {}
      return res.status(200).json({
        ok: true,
        warning,
        address: {
          street: a.street1 || '',
          street2: a.street2 || '',
          city: a.city || '',
          state: a.state || '',
          zip: (a.zip || '').slice(0, 5)
        }
      });
    }

    // ── STEP 2: buy the chosen rate and return the printable label ──
    if (body.action === 'buy') {
      const sid = String(body.shipmentId || '');
      const rid = String(body.rateId || '');
      if (!sid || !rid) return res.status(400).json({ ok: false, error: 'Missing shipment or rate.' });

      const r = await timed(fetch(`https://api.easypost.com/v2/shipments/${sid}/buy`, {
        method: 'POST', headers,
        body: JSON.stringify({ rate: { id: rid } })
      }), 20000);
      const data = await r.json();
      if (!r.ok || !data.postage_label) {
        const msg = (data.error && data.error.message) || 'Could not buy that label.';
        return res.status(422).json({ ok: false, error: msg });
      }
      return res.status(200).json({
        ok: true,
        labelUrl: data.postage_label.label_url,
        tracking: data.tracking_code || '',
        trackingUrl: data.tracker && data.tracker.public_url ? data.tracker.public_url : '',
        carrier: data.selected_rate ? data.selected_rate.carrier : '',
        service: data.selected_rate ? data.selected_rate.service : '',
        price: data.selected_rate ? Number(data.selected_rate.rate) : null
      });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Shipping service unavailable.' });
  }
}
