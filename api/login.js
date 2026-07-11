// POST /api/login  { pin } → 200 { ok: true } if PIN matches, 401 otherwise.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const pin = body && body.pin != null ? String(body.pin) : '';
  const expected = process.env.APP_PIN;
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'PIN not configured on server' });
  }
  if (pin === expected) {
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Invalid PIN' });
}
