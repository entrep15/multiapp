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
function getEventsByDay(allEvents, dayMs) {
  const cutoff = dayMs;
  const nextDayMs = dayMs + (24 * 60 * 60 * 1000);
  return allEvents.filter(e => e.ts >= cutoff && e.ts < nextDayMs);
}

// Parse PT date and get midnight PT timestamp
function getMidnightPT(date) {
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

// Calculate day-over-day stats for a table
function getTableStats(events, op, table, mode) {
  const firstAttemptCorrect = events.filter(e =>
    e.type === 'correct' && e.op === op && e.table === table && e.mode === mode && e.firstAttempt
  ).length;

  const totalFirstAttempts = events.filter(e =>
    (e.type === 'correct' || e.type === 'wrong' || e.type === 'timeout') &&
    e.op === op && e.table === table && e.mode === mode && e.firstAttempt
  ).length;

  const secondAttemptCorrect = events.filter(e =>
    e.type === 'correct' && e.op === op && e.table === table && e.mode === mode && !e.firstAttempt
  ).length;

  const totalSecondAttempts = events.filter(e =>
    (e.type === 'correct' || e.type === 'wrong' || e.type === 'timeout') &&
    e.op === op && e.table === table && e.mode === mode && !e.firstAttempt
  ).length;

  return {
    firstAttemptCorrect,
    firstAttemptTotal: totalFirstAttempts,
    firstAttemptPct: totalFirstAttempts > 0 ? Math.round((firstAttemptCorrect / totalFirstAttempts) * 1000) / 10 : 0,
    secondAttemptCorrect,
    secondAttemptTotal: totalSecondAttempts,
    secondAttemptPct: totalSecondAttempts > 0 ? Math.round((secondAttemptCorrect / totalSecondAttempts) * 1000) / 10 : 0,
    resets: events.filter(e => e.type === 'cheetah-strike' && e.strikeNumber === 2 && e.op === op && e.table === table).length
  };
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

      const firstImprovement = (today.firstAttemptPct || 0) - (yesterday.firstAttemptPct || 0);
      const secondImprovement = (today.secondAttemptPct || 0) - (yesterday.secondAttemptPct || 0);
      const resetImprovement = (today.resets || 0) - (yesterday.resets || 0);

      const getColor = (pct) => {
        if (pct > 0) return 'rgb(134, 239, 52)';
        if (pct < 0) return 'rgb(253, 165, 151)';
        return 'rgb(187, 247, 208)';
      };

      const getResetColor = (delta) => {
        if (delta > 0) return 'rgb(248, 180, 160)';
        if (delta < 0) return 'rgb(77, 214, 74)';
        return 'rgb(187, 247, 208)';
      };

      rows += `
        <tr>
          <td class="col-table">${table}</td>
          <td>${today.firstAttemptTotal > 0 ? today.firstAttemptCorrect + ' / ' + today.firstAttemptTotal : '— / —'}</td>
          <td>${today.firstAttemptPct > 0 ? today.firstAttemptPct + '%' : '—'}</td>
          <td class="heatmap-improvement" style="background-color: ${getColor(firstImprovement)};">${firstImprovement > 0 ? '↑ +' : firstImprovement < 0 ? '↓ ' : '→ '}${Math.abs(firstImprovement).toFixed(1)}%</td>
          <td>${today.secondAttemptTotal > 0 ? today.secondAttemptCorrect + ' / ' + today.secondAttemptTotal : '— / —'}</td>
          <td>${today.secondAttemptPct > 0 ? today.secondAttemptPct + '%' : '—'}</td>
          <td class="heatmap-improvement" style="background-color: ${getColor(secondImprovement)};">${secondImprovement > 0 ? '↑ +' : secondImprovement < 0 ? '↓ ' : '→ '}${Math.abs(secondImprovement).toFixed(1)}%</td>
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

    return res.status(200).json({ ok: true, sentTo: RECIPIENTS, eventCount: todayEvents.length });
  } catch (e) {
    console.error('Error sending Cheetah report:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
