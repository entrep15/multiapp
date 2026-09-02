// POST /api/skip-eligibility  { pin } → { ok, eligibility: { multiplication: {t: bool}, division: {t: bool} } }
//
// A table is skip-eligible when its last 3 Cheetah COMPLETIONS were all
// PERFECT FIRST-TRY RUNS. Per Raja (2026-08-28): the run that completes the
// table must have all 10 problems answered correctly on the FIRST attempt
// (no second chances used anywhere in the completing run). Three such
// completions in a row earn the Skip — they do NOT have to fall on
// consecutive calendar days (day 1, day 1+n, day 1+n+x all count). An
// imperfect completion in between resets the count.
//
// A "perfect run" is judged on the COMPLETING run only: an earlier failed
// attempt the same day (table reset, then a clean 10/10) does not spoil it.
// Detection: the 10 correct answers immediately before the mode-complete
// must all carry firstAttempt: true, with no cheetah-strike events inside
// that window.
//
// STREAK_RESET_EPOCH: all progress toward Skip was reset when this rule
// shipped — only events after the epoch count.
export const STREAK_RESET_EPOCH = 1787954449000; // 2026-08-28 15:00 PT

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

export function computeEligibility(allEvents, resetEpoch = STREAK_RESET_EPOCH) {
  // Per (op, table): chronological cheetah corrects / strikes / completions
  // after the reset epoch.
  const groups = {};
  for (const e of allEvents) {
    if (typeof e.ts !== 'number' || e.ts < resetEpoch) continue;
    const t = e.table;
    if (typeof t !== 'number' || t < 2 || t > 10) continue;
    const isCorrect = e.type === 'correct' && e.mode === 'cheetah';
    const isStrike = e.type === 'cheetah-strike';
    const isComplete = e.type === 'mode-complete' && e.mode === 'cheetah';
    if (!isCorrect && !isStrike && !isComplete) continue;
    const op = e.op === 'division' ? 'division' : 'multiplication';
    const k = op + '|' + t;
    (groups[k] = groups[k] || []).push(e);
  }

  const eligibility = { multiplication: {}, division: {} };
  for (const op of ['multiplication', 'division']) {
    for (let t = 2; t <= 10; t++) {
      const ev = (groups[op + '|' + t] || []).sort((a, b) => a.ts - b.ts);
      // Every completion becomes one "time"; judge each completing run:
      // walk back from the mode-complete collecting the last 10 corrects —
      // hitting a strike first, or any correct not flagged first-try,
      // makes that completion imperfect.
      const completions = [];
      for (let i = 0; i < ev.length; i++) {
        if (ev[i].type !== 'mode-complete') continue;
        const window10 = [];
        let strikeInWindow = false;
        for (let j = i - 1; j >= 0 && window10.length < 10; j--) {
          if (ev[j].type === 'correct') window10.push(ev[j]);
          else if (ev[j].type === 'cheetah-strike') { strikeInWindow = true; break; }
        }
        const perfect = !strikeInWindow && window10.length === 10 &&
          window10.every(c => c.firstAttempt === true);
        completions.push(perfect);
      }
      const last3 = completions.slice(-3);
      eligibility[op][t] = last3.length === 3 && last3.every(Boolean);
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
