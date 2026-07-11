// POST /api/sync  { pin, state?, event? } → persists latest state and appends event to Redis log.
//
// Storage layout in Upstash Redis:
//   state:drohn       — JSON of the latest full combined game state
//   events:drohn      — Redis list (LPUSH); each entry is JSON { ts, type, op, table, mode, ... }

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('Upstash credentials not configured');
  }
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error('Redis ' + r.status + ': ' + text);
  }
  return await r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const pin = body && body.pin != null ? String(body.pin) : '';
  if (pin !== process.env.APP_PIN) {
    return res.status(401).json({ ok: false, error: 'Invalid PIN' });
  }

  try {
    if (body.state && typeof body.state === 'object') {
      await redis(['SET', 'state:drohn', JSON.stringify(body.state)]);
    }
    if (body.event && typeof body.event === 'object') {
      const enriched = Object.assign({ ts: Date.now() }, body.event);
      await redis(['LPUSH', 'events:drohn', JSON.stringify(enriched)]);
      // Keep the log bounded — most recent 20k events
      await redis(['LTRIM', 'events:drohn', '0', '19999']);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
