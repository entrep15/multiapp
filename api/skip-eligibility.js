// POST /api/skip-eligibility  { pin } → { ok, eligibility: { multiplication: {t: bool}, division: {t: bool} } }
//
// A table is skip-eligible when its 3 most recent QUALIFYING days were all
// GOOD. Per Raja (2026-07-28): a day is GOOD as long as the table was
// COMPLETED in Cheetah that day — it does not matter whether individual
// problems were solved on the first or second try. Per (op, table):
//   - good:    a cheetah mode-complete that day (retries forgiven)
//   - bad:     played with misses but NEVER completed the table that day
//              (breaks the streak)
//   - neutral: brief clean play with no misses and no completion (day ended
//              mid-table — ignored, neither extends nor breaks the streak)
// Days don't have to be consecutive calendar days — only the last 3 qualifying
// days matter.
//
// A "miss" (used only to tell bad days from neutral ones) is any of, across
// all logging eras (cheetah-strike events only started 2026-07-06):
//   - a cheetah-strike event
//   - a cheetah wrong/timeout answer event
//   - a cheetah correct with firstAttempt === false

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('Redis ' + r.status + ': ' + (await r.text()));
  return await r.json();
}

// PT calendar day key for a timestamp, e.g. "2026-07-11"
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Los_Angeles'
});
function ptDayKey(ts) {
  return dayFmt.format(new Date(ts));
}

export function computeEligibility(allEvents) {
  // days[op][table][dayKey] = { imperfections, completed, played }
  const days = { multiplication: {}, division: {} };

  for (const e of allEvents) {
    const op = e.op === 'division' ? 'division' : 'multiplication';
    const t = e.table;
    if (typeof t !== 'number' || t < 2 || t > 10) continue;

    const isStrike = e.type === 'cheetah-strike';
    const isCheetahMiss = (e.type === 'wrong' || e.type === 'timeout') && e.mode === 'cheetah';
    const isSecondTryCorrect = e.type === 'correct' && e.mode === 'cheetah' && e.firstAttempt === false;
    const isCheetahAnswer = (e.type === 'correct' || e.type === 'wrong' || e.type === 'timeout') && e.mode === 'cheetah';
    const isCheetahComplete = e.type === 'mode-complete' && e.mode === 'cheetah';
    if (!isStrike && !isCheetahAnswer && !isCheetahComplete) continue;

    const day = ptDayKey(e.ts);
    if (!days[op][t]) days[op][t] = {};
    if (!days[op][t][day]) days[op][t][day] = { imperfections: 0, completed: false, played: false };
    const d = days[op][t][day];
    d.played = true;
    if (isStrike || isCheetahMiss || isSecondTryCorrect) d.imperfections++;
    if (isCheetahComplete) d.completed = true;
  }

  const eligibility = { multiplication: {}, division: {} };
  for (const op of ['multiplication', 'division']) {
    for (let t = 2; t <= 10; t++) {
      const perTable = days[op][t] || {};
      // Qualifying days (perfect or imperfect), most recent first
      const qualifying = Object.keys(perTable)
        .filter(day => {
          const d = perTable[day];
          return d.imperfections > 0 || d.completed; // neutral days drop out
        })
        .sort()
        .reverse();
      const last3 = qualifying.slice(0, 3);
      // GOOD day = completed the table that day (retries within the day are fine)
      eligibility[op][t] = last3.length === 3 &&
        last3.every(day => perTable[day].completed);
    }
  }
  return eligibility;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const pin = body && body.pin != null ? String(body.pin) : '';
  if (!process.env.APP_PIN || pin !== process.env.APP_PIN) {
    return res.status(401).json({ ok: false });
  }
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ ok: false, error: 'Redis not configured' });

  try {
    const eventsRes = await redis(['LRANGE', 'events:drohn', '0', '-1']);
    const allEvents = ((eventsRes && eventsRes.result) || [])
      .map(e => { try { return JSON.parse(e); } catch (err) { return null; } })
      .filter(Boolean);
    return res.status(200).json({ ok: true, eligibility: computeEligibility(allEvents) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
