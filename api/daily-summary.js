// GET /api/daily-summary?secret=...&hours=24
// Returns a structured summary of the kid's activity over the last N hours.
// Used by the daily-email GitHub Action — not by the game itself.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + REDIS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('Redis ' + r.status + ': ' + (await r.text()));
  return await r.json();
}

function emptyOpSummary() {
  return {
    questions: 0,
    correct: 0,
    wrong: 0,
    timeouts: 0,
    byTable: {},          // table → { correct, wrong, byMode: { mode → { correct, wrong } } }
    modesCompleted: [],   // [{ table, mode }]
    tablesCompleted: [],  // [tableNumber]
    demotions: []         // [{ table, fromMode, toMode }]
  };
}

// Group events into sessions (gap > 5 min = new session) and sum each session's span
function computePlayMinutes(events) {
  if (!events.length) return 0;
  const sorted = events.slice().sort(function (a, b) { return a.ts - b.ts; });
  const SESSION_GAP = 5 * 60 * 1000;
  let total = 0;
  let sessionStart = sorted[0].ts;
  let lastTs = sorted[0].ts;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i].ts;
    if (t - lastTs > SESSION_GAP) {
      total += lastTs - sessionStart;
      sessionStart = t;
    }
    lastTs = t;
  }
  total += lastTs - sessionStart;
  return Math.round(total / 60000);
}

function bumpTable(s, table, mode, field) {
  const t = String(table);
  if (!s.byTable[t]) s.byTable[t] = { correct: 0, wrong: 0, byMode: {} };
  s.byTable[t][field]++;
  const m = mode || 'unknown';
  if (!s.byTable[t].byMode[m]) s.byTable[t].byMode[m] = { correct: 0, wrong: 0 };
  s.byTable[t].byMode[m][field]++;
}

export default async function handler(req, res) {
  const secret = req.query.secret || req.headers['x-secret'];
  if (!process.env.SUMMARY_SECRET || secret !== process.env.SUMMARY_SECRET) {
    return res.status(401).json({ ok: false });
  }
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Upstash credentials not configured' });
  }

  try {
    const stateRes = await redis(['GET', 'state:drohn']);
    const eventsRes = await redis(['LRANGE', 'events:drohn', '0', '19999']);

    const state = stateRes && stateRes.result ? JSON.parse(stateRes.result) : null;
    const allEvents = ((eventsRes && eventsRes.result) || [])
      .map(function (e) { try { return JSON.parse(e); } catch (err) { return null; } })
      .filter(Boolean);

    const hours = Number(req.query.hours || 24);
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const recent = allEvents.filter(function (e) { return e.ts >= cutoff; });

    const summary = {
      multiplication: emptyOpSummary(),
      division: emptyOpSummary()
    };

    for (const e of recent) {
      const op = e.op === 'division' ? 'division' : 'multiplication';
      const s = summary[op];
      if (e.type === 'correct') {
        s.correct++; s.questions++;
        bumpTable(s, e.table, e.mode, 'correct');
        // Track first vs second attempt
        if (!s.byTable[String(e.table)].firstAttempts) s.byTable[String(e.table)].firstAttempts = 0;
        if (!s.byTable[String(e.table)].secondAttempts) s.byTable[String(e.table)].secondAttempts = 0;
        if (e.firstAttempt) {
          s.byTable[String(e.table)].firstAttempts++;
        } else {
          s.byTable[String(e.table)].secondAttempts++;
        }
      } else if (e.type === 'wrong') {
        s.wrong++; s.questions++;
        bumpTable(s, e.table, e.mode, 'wrong');
      } else if (e.type === 'timeout') {
        s.timeouts++; s.wrong++; s.questions++;
        bumpTable(s, e.table, e.mode, 'wrong');
      } else if (e.type === 'mode-complete') {
        s.modesCompleted.push({ table: e.table, mode: e.mode });
        if (!s.byTable[String(e.table)]) s.byTable[String(e.table)] = { correct: 0, wrong: 0, byMode: {} };
        if (e.mode === 'cheetah') s.byTable[String(e.table)].completedMode = 'cheetah';
      } else if (e.type === 'table-complete') {
        s.tablesCompleted.push(e.table);
      } else if (e.type === 'cheetah-strike' && e.strikeNumber === 2) {
        s.demotions.push({ table: e.table, strikeType: 'strike-2', description: 'Table reset to problem 1' });
        if (!s.byTable[String(e.table)]) s.byTable[String(e.table)] = { correct: 0, wrong: 0, byMode: {} };
        if (!s.byTable[String(e.table)].demotions) s.byTable[String(e.table)].demotions = 0;
        s.byTable[String(e.table)].demotions++;
      } else if (e.type === 'cheetah-demote') {
        s.demotions.push({ table: e.table, fromMode: 'cheetah', toMode: e.toMode || 'snail' });
        if (!s.byTable[String(e.table)]) s.byTable[String(e.table)] = { correct: 0, wrong: 0, byMode: {} };
        if (!s.byTable[String(e.table)].demotions) s.byTable[String(e.table)].demotions = 0;
        s.byTable[String(e.table)].demotions++;
      }
    }

    const playMinutes = computePlayMinutes(recent);

    return res.status(200).json({
      ok: true,
      hours: hours,
      now: new Date().toISOString(),
      eventCount: recent.length,
      playMinutes: playMinutes,
      summary: summary,
      currentState: state
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
