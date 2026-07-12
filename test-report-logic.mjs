import { getTableStats, getEventsByDay, getMidnightPT } from './api/send-cheetah-report.js';

// Run with: node --env-file=.env.local test-report-logic.mjs
const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;
if (!REDIS_URL || !REDIS_TOKEN) { console.error('Missing KV_REST_API_URL / KV_REST_API_TOKEN (use --env-file=.env.local)'); process.exit(1); }

const r = await fetch(REDIS_URL, {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify(['LRANGE', 'events:drohn', '0', '-1'])
});
const all = ((await r.json()).result || []).map(e => { try { return JSON.parse(e); } catch { return null; } }).filter(Boolean);

const tMid = getMidnightPT(new Date());
const today = getEventsByDay(all, tMid);
const yesterday = getEventsByDay(all, tMid - 86400000);

let failures = 0;
function show(label, events) {
  console.log(`\n=== ${label} ===`);
  console.log('op    tbl | 1st try      | 2nd try     | resets | reconciles?');
  for (const [op, tbls] of [['multiplication', [2,3,4,5,6,7,8,9,10]], ['division', [2,3]]]) {
    for (const t of tbls) {
      const s = getTableStats(events, op, t, 'cheetah');
      if (s.firstAttemptTotal === 0 && s.secondAttemptTotal === 0 && s.resets === 0) continue;
      const ok = s.reconciles ? 'OK' : '*** FAIL ***';
      if (!s.reconciles) failures++;
      console.log(`${op.slice(0,4).padEnd(5)} ${String(t).padEnd(3)} | ${s.firstAttemptCorrect}/${s.firstAttemptTotal} = ${String(s.firstAttemptPct).padEnd(5)}% | ${s.secondAttemptCorrect}/${s.secondAttemptTotal} = ${String(s.secondAttemptPct).padEnd(5)}% | ${s.resets}      | ${ok}`);
      // Cross-check: 2nd-try total must equal 1st-try misses
      const firstMisses = s.firstAttemptTotal - s.firstAttemptCorrect;
      if (firstMisses !== s.secondAttemptTotal) {
        console.log(`   *** MISMATCH: 1st-try misses (${firstMisses}) != 2nd-try total (${s.secondAttemptTotal})`);
        failures++;
      }
    }
  }
}

show('TODAY', today);
show('YESTERDAY', yesterday);
console.log(failures === 0 ? '\nALL RECONCILIATION CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
