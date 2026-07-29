// GET /api/send-cheetah-report
// Sends the Cheetah Mode day-over-day performance report as an HTML email.
// Triggered by Vercel Cron daily at 6 PM PT (1:00 AM UTC).
//
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` automatically.
// For manual testing, also accepts `?secret=...` query param.

import nodemailer from 'nodemailer';

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const RECIPIENTS = ['raja.s.muthuraman@gmail.com', 'surekha.anant@gmail.com'];
const SUBJECT = "Drohn Raja's Cheetah Mode - Day Over Day Report";
const STATES_SUBJECT = "Drohn Raja's US States Cheetah Mode - Daily Report";

const STATE_NAMES = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California',
  co: 'Colorado', ct: 'Connecticut', de: 'Delaware', fl: 'Florida', ga: 'Georgia',
  hi: 'Hawaii', id: 'Idaho', il: 'Illinois', in: 'Indiana', ia: 'Iowa',
  ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana', me: 'Maine', md: 'Maryland',
  ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi', mo: 'Missouri',
  mt: 'Montana', ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire', nj: 'New Jersey',
  nm: 'New Mexico', ny: 'New York', nc: 'North Carolina', nd: 'North Dakota', oh: 'Ohio',
  ok: 'Oklahoma', or: 'Oregon', pa: 'Pennsylvania', ri: 'Rhode Island', sc: 'South Carolina',
  sd: 'South Dakota', tn: 'Tennessee', tx: 'Texas', ut: 'Utah', vt: 'Vermont',
  va: 'Virginia', wa: 'Washington', wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming'
};

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('Redis ' + r.status + ': ' + (await r.text()));
  return await r.json();
}

// Get all events from Redis and parse them
async function getAllEvents() {
  const eventsRes = await redis(['LRANGE', 'events:drohn', '0', '-1']);
  if (!eventsRes || !eventsRes.result) return [];
  return eventsRes.result
    .map(e => { try { return JSON.parse(e); } catch (err) { return null; } })
    .filter(Boolean);
}

// Get statistics for a specific day (PT timezone)
export function getEventsByDay(allEvents, dayMs) {
  const cutoff = dayMs;
  const nextDayMs = dayMs + (24 * 60 * 60 * 1000);
  return allEvents.filter(e => e.ts >= cutoff && e.ts < nextDayMs);
}

// Parse PT date and get midnight PT timestamp
export function getMidnightPT(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Los_Angeles'
  });
  const parts = formatter.formatToParts(date);
  const year = parseInt(parts.find(p => p.type === 'year').value);
  const month = parseInt(parts.find(p => p.type === 'month').value) - 1;
  const day = parseInt(parts.find(p => p.type === 'day').value);
  return new Date(year, month, day).getTime();
}

// Calculate day-over-day stats for a table.
//
// Event-log facts this relies on (verified against live data):
// - Each correct answer produces a 'correct' event carrying firstAttempt: true/false.
//   (The client used to ALSO post a legacy duplicate without the flag — since removed —
//   so unflagged 'correct' events must be ignored, never counted.)
// - Each miss produces a 'cheetah-strike' event: strikeNumber 1 = missed 1st try
//   (earns a 2nd chance), strikeNumber 2 = missed 2nd try (table resets).
//
// Therefore, per table:
//   1st-try total   = flagged 1st-try corrects + strike-1 count
//   2nd-try total   = strike-1 count (every strike 1 gets a 2nd chance)
//   2nd-try correct = flagged 2nd-try corrects
//   resets          = strike-2 count
// Invariant: 2nd-try correct + resets === 2nd-try total.
export function getTableStats(events, op, table, mode) {
  const forTable = events.filter(e => e.op === op && e.table === table);

  const firstAttemptCorrect = forTable.filter(e =>
    e.type === 'correct' && e.mode === mode && e.firstAttempt === true
  ).length;

  const secondAttemptCorrect = forTable.filter(e =>
    e.type === 'correct' && e.mode === mode && e.firstAttempt === false
  ).length;

  const strike1 = forTable.filter(e => e.type === 'cheetah-strike' && e.strikeNumber === 1).length;
  const strike2 = forTable.filter(e => e.type === 'cheetah-strike' && e.strikeNumber === 2).length;

  const firstAttemptTotal = firstAttemptCorrect + strike1;
  const secondAttemptTotal = strike1;

  return {
    firstAttemptCorrect,
    firstAttemptTotal,
    firstAttemptPct: firstAttemptTotal > 0 ? Math.round((firstAttemptCorrect / firstAttemptTotal) * 1000) / 10 : 0,
    secondAttemptCorrect,
    secondAttemptTotal,
    secondAttemptPct: secondAttemptTotal > 0 ? Math.round((secondAttemptCorrect / secondAttemptTotal) * 1000) / 10 : 0,
    resets: strike2,
    reconciles: secondAttemptCorrect + strike2 === secondAttemptTotal
  };
}

// ----- US States daily report: CHEETAH MODE ONLY (per Raja, 2026-07) -----
// Cheetah = flash card shows the state's name, the kid clicks where it is;
// 3 chances per state. Events: states-cheetah-correct {state, attempt 1|2|3}
// and states-cheetah-fail {state} (not found in 3 tries).
// If a state was played in multiple rounds in one day, the FIRST result of
// the day is reported (their starting knowledge, before repeats).
export function buildStatesStats(todayEvents) {
  const cheetah = {};   // code -> 1 | 2 | 3 (attempt it was found on) | 0 (not in 3)
  let rounds = 0;
  const sorted = todayEvents.slice().sort((a, b) => a.ts - b.ts);
  for (const e of sorted) {
    if (e.type === 'states-cheetah-correct' && STATE_NAMES[e.state]) {
      if (!(e.state in cheetah)) cheetah[e.state] = [1, 2, 3].includes(e.attempt) ? e.attempt : 1;
    } else if (e.type === 'states-cheetah-fail' && STATE_NAMES[e.state]) {
      if (!(e.state in cheetah)) cheetah[e.state] = 0;
    } else if (e.type === 'states-cheetah-round-complete') {
      rounds++;
    }
  }
  return { cheetah, rounds };
}

export function buildStatesReportHTML(s) {
  const todayPT = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
  const codes = Object.keys(s.cheetah).sort((a, b) => STATE_NAMES[a] < STATE_NAMES[b] ? -1 : 1);

  let body;
  if (!codes.length) {
    body = '<p style="font-size:16px;">😴 Drohn didn\'t play Cheetah Mode on the map today.</p>';
  } else {
    const RESULT = {
      1: { label: '🌟 First try', bg: '#e7f8e7' },
      2: { label: '✌️ Second try', bg: '#f2f8e0' },
      3: { label: '3️⃣ Third try', bg: '#fdf3dd' },
      0: { label: '❌ Not in 3 tries', bg: '#fdeaea' }
    };
    const counts = { 1: 0, 2: 0, 3: 0, 0: 0 };
    let rows = '';
    for (const c of codes) {
      const r = s.cheetah[c];
      counts[r]++;
      rows += '<tr style="background:' + RESULT[r].bg + ';">' +
        '<td style="padding:6px 10px;border-bottom:1px solid #fff;"><b>' + STATE_NAMES[c] + '</b></td>' +
        '<td style="padding:6px 10px;border-bottom:1px solid #fff;">' + RESULT[r].label + '</td></tr>';
    }
    body =
      '<p style="font-size:15px;"><b>' + codes.length + ' state' + (codes.length === 1 ? '' : 's') + ' attempted:</b> ' +
      '🌟 ' + counts[1] + ' on the first try · ✌️ ' + counts[2] + ' on the second · 3️⃣ ' + counts[3] + ' on the third · ❌ ' + counts[0] + ' not found</p>' +
      (s.rounds ? '<p style="font-size:14px;">🏁 Finished ' + s.rounds + ' full 50-state round' + (s.rounds === 1 ? '' : 's') + ' today.</p>' : '') +
      '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:10px 0 16px;">' +
      '<tr style="background:#f1edf6;"><th style="text-align:left;padding:6px 10px;">State</th>' +
      '<th style="text-align:left;padding:6px 10px;">Found on</th></tr>' + rows + '</table>';
  }

  return '<!doctype html><html><body style="font-family:-apple-system,\'Segoe UI\',Helvetica,Arial,sans-serif;color:#222;max-width:640px;margin:0 auto;padding:20px;background:#fff;">' +
    '<h1 style="color:#5d3a82;margin-bottom:0;">🐆 Drohn Raja — US States Cheetah Mode</h1>' +
    '<p style="color:#888;font-size:13px;margin-top:4px;">' + todayPT + '</p>' +
    body +
    '<hr style="border:none;border-top:1px solid #ddd;margin:28px 0 12px;"/>' +
    '<p style="font-size:11px;color:#aaa;">Sent by Vercel Cron · <a href="https://multiplication-practice-zeta.vercel.app/states.html" style="color:#888;">Open the map</a></p>' +
    '</body></html>';
}

// Build the report HTML
function buildReportHTML(todayStats, yesterdayStats) {
  const now = new Date();
  const todayPT = new Date(now.getTime() - (now.getTimezoneOffset() + 420) * 60000).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  const tables = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  const divisionTables = [2, 3];

  const renderTable = (name, operation, tableList) => {
    let rows = '';
    for (const table of tableList) {
      const today = todayStats[operation][table] || {};
      const yesterday = yesterdayStats[operation][table] || {};

      // Improvement cell: only compare when both days have data for that metric.
      // Today only → "✨ New" (first day of data); no data today → "—" (nothing to compare).
      const improvementCell = (todayTotal, todayPct, yTotal, yPct) => {
        if (todayTotal > 0 && yTotal > 0) {
          const d = todayPct - yPct;
          if (d > 0) return { text: '↑ +' + d.toFixed(1) + '%', color: 'rgb(134, 239, 52)' };
          if (d < 0) return { text: '↓ ' + Math.abs(d).toFixed(1) + '%', color: 'rgb(253, 165, 151)' };
          return { text: '→ 0.0%', color: 'rgb(187, 247, 208)' };
        }
        if (todayTotal > 0) return { text: '✨ New', color: 'rgb(220, 252, 201)' };
        return { text: '—', color: 'rgb(229, 229, 229)' };
      };

      const first = improvementCell(today.firstAttemptTotal || 0, today.firstAttemptPct || 0,
                                    yesterday.firstAttemptTotal || 0, yesterday.firstAttemptPct || 0);
      const second = improvementCell(today.secondAttemptTotal || 0, today.secondAttemptPct || 0,
                                     yesterday.secondAttemptTotal || 0, yesterday.secondAttemptPct || 0);

      const resetImprovement = (today.resets || 0) - (yesterday.resets || 0);
      const getResetColor = (delta) => {
        if (delta > 0) return 'rgb(248, 180, 160)';
        if (delta < 0) return 'rgb(77, 214, 74)';
        return 'rgb(187, 247, 208)';
      };

      rows += `
        <tr>
          <td class="col-table">${table}</td>
          <td>${today.firstAttemptTotal > 0 ? today.firstAttemptCorrect + ' / ' + today.firstAttemptTotal : '— / —'}</td>
          <td>${today.firstAttemptTotal > 0 ? today.firstAttemptPct + '%' : '—'}</td>
          <td class="heatmap-improvement" style="background-color: ${first.color};">${first.text}</td>
          <td>${today.secondAttemptTotal > 0 ? today.secondAttemptCorrect + ' / ' + today.secondAttemptTotal : '— / —'}</td>
          <td>${today.secondAttemptTotal > 0 ? today.secondAttemptPct + '%' : '—'}</td>
          <td class="heatmap-improvement" style="background-color: ${second.color};">${second.text}</td>
          <td>${today.resets || 0}</td>
          <td class="heatmap-reset-improvement" style="background-color: ${getResetColor(resetImprovement)};">${resetImprovement > 0 ? '↑ ' + resetImprovement + ' more' : resetImprovement < 0 ? '↓ ' + Math.abs(resetImprovement) + ' fewer' : '→ Same'}</td>
        </tr>
      `;
    }

    return `
      <h2>${name}</h2>
      <table>
        <thead>
          <tr>
            <th class="col-table">Table</th>
            <th class="group-first-try">Today's 1st Try: Raw #</th>
            <th class="group-first-try">Today: 1st Try %</th>
            <th class="group-first-try">1st Try Improvement Day Over Day</th>
            <th class="group-second-try">Today's 2nd Try: Raw #</th>
            <th class="group-second-try">Today: 2nd Try %</th>
            <th class="group-second-try">2nd Try Improvement Day Over Day</th>
            <th class="group-resets">Today Resets</th>
            <th class="group-resets">Reset Improvement Day Over Day</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cheetah Mode - Day Over Day Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: #f5f5f5;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    h1 {
      text-align: center;
      margin-bottom: 30px;
      color: #333;
      font-size: 24px;
    }
    h2 {
      margin-top: 30px;
      margin-bottom: 15px;
      color: #555;
      font-size: 18px;
      border-bottom: 2px solid #ddd;
      padding-bottom: 10px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 40px;
      font-size: 14px;
    }
    th {
      padding: 12px 8px;
      text-align: left;
      font-weight: 600;
      color: white;
      border-bottom: 2px solid #333;
    }
    td {
      padding: 12px 8px;
      border-bottom: 1px solid #e0e0e0;
    }
    tr:last-child td { border-bottom: 2px solid #333; }
    .group-first-try { background: #1e40af; }
    .group-second-try { background: #7c3aed; }
    .group-resets { background: #dc2626; }
    .col-table {
      font-weight: 600;
      width: 50px;
      text-align: center;
    }
    .heatmap-improvement {
      text-align: center;
      font-weight: 500;
      color: black;
    }
    .heatmap-reset-improvement {
      text-align: center;
      font-weight: 500;
      color: black;
    }
    .heatmap-reset-improvement.dark {
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🐆 Cheetah Mode - Day Over Day Improvement</h1>
    <p style="text-align: center; color: #888; margin-bottom: 20px;">${todayPT}</p>
    ${renderTable('Multiplication', 'multiplication', tables)}
    ${renderTable('Division', 'division', divisionTables)}
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  // Auth check
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const querySecret = req.query.secret;
  const ok = process.env.CRON_SECRET && (bearer === process.env.CRON_SECRET || querySecret === process.env.CRON_SECRET);
  if (!ok) return res.status(401).json({ ok: false });

  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ ok: false, error: 'Redis not configured' });
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ ok: false, error: 'Gmail credentials not configured' });
  }

  try {
    const allEvents = await getAllEvents();

    // Get today and yesterday in PT timezone
    const now = Date.now();
    const todayMidnightPT = getMidnightPT(new Date(now));
    const yesterdayMidnightPT = todayMidnightPT - (24 * 60 * 60 * 1000);

    const todayEvents = getEventsByDay(allEvents, todayMidnightPT);
    const yesterdayEvents = getEventsByDay(allEvents, yesterdayMidnightPT);

    // Build statistics for both days
    const buildStats = (events) => {
      const stats = { multiplication: {}, division: {} };
      for (let table = 2; table <= 10; table++) {
        stats.multiplication[table] = getTableStats(events, 'multiplication', table, 'cheetah');
      }
      for (let table = 2; table <= 3; table++) {
        stats.division[table] = getTableStats(events, 'division', table, 'cheetah');
      }
      return stats;
    };

    const todayStats = buildStats(todayEvents);
    const yesterdayStats = buildStats(yesterdayEvents);

    const html = buildReportHTML(todayStats, yesterdayStats);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: RECIPIENTS.join(', '),
      subject: SUBJECT,
      html: html
    });

    // Second email from the same cron slot (Hobby plan caps this project at
    // 2 crons): the US States daily report.
    const statesStats = buildStatesStats(todayEvents);
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: RECIPIENTS.join(', '),
      subject: STATES_SUBJECT,
      html: buildStatesReportHTML(statesStats)
    });

    return res.status(200).json({
      ok: true, sentTo: RECIPIENTS, eventCount: todayEvents.length,
      cheetahStatesAttempted: Object.keys(statesStats.cheetah).length
    });
  } catch (e) {
    console.error('Error sending Cheetah report:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
