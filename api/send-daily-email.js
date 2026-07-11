// GET /api/send-daily-email
// Triggered by Vercel Cron daily. Fetches activity from Redis,
// formats an HTML digest, and emails both parents via Gmail SMTP.
//
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` automatically.
// For manual testing, also accepts `?secret=...` query param.

import nodemailer from 'nodemailer';

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const RECIPIENTS = ['raja.s.muthuraman@gmail.com', 'surekha.anant@gmail.com'];
const SUBJECT = "Daily update: Drohn Raja's Multiplication & Division progress";

const MODE_LABEL = {
  snail: 'Snail Mode 🐌',
  dog: 'Dog Mode 🐕',
  cheetah: 'Cheetah Mode 🐆',
  classic: 'Snail Mode 🐌',
  sonic: 'Dog Mode 🐕',
  supersonic: 'Cheetah Mode 🐆'
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

function emptyOp() {
  return { questions: 0, correct: 0, wrong: 0, timeouts: 0, byTable: {},
           modesCompleted: [], tablesCompleted: [], demotions: [] };
}

function computePlayMinutes(events) {
  if (!events.length) return 0;
  const s = events.slice().sort((a, b) => a.ts - b.ts);
  const GAP = 5 * 60 * 1000;
  let total = 0, sessionStart = s[0].ts, last = s[0].ts;
  for (let i = 1; i < s.length; i++) {
    const t = s[i].ts;
    if (t - last > GAP) { total += last - sessionStart; sessionStart = t; }
    last = t;
  }
  total += last - sessionStart;
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

function renderOpSection(name, op, currentState, prevOp) {
  const acc = op.questions ? Math.round((op.correct / op.questions) * 100) : 0;

  // Build detailed per-table breakdown
  let detailedTableRows = '';
  const tables = Object.keys(op.byTable).sort((a, b) => Number(a) - Number(b));
  for (const tbl of tables) {
    const td = op.byTable[tbl];
    const prevTd = prevOp && prevOp.byTable ? prevOp.byTable[tbl] : null;
    const prevTime = prevTd && prevTd.completionTime ? prevTd.completionTime : null;
    const currTime = td.completionTime || null;

    let timeStr = currTime ? `${currTime}s` : 'In progress';
    let timeCompare = '';
    if (currTime && prevTime) {
      const pct = Math.round(((currTime - prevTime) / prevTime) * 100);
      timeCompare = pct > 0 ? ` (+${pct}%)` : ` (${pct}%)`;
    }

    const modeStr = td.completedMode ? `${MODE_LABEL[td.completedMode] || td.completedMode}` : 'Not completed';
    const firstAttempts = td.firstAttempts || 0;
    const secondAttempts = td.secondAttempts || 0;
    const demotions = td.demotions || 0;
    const attemptsStr = firstAttempts || secondAttempts
      ? `${firstAttempts} 1st attempt${firstAttempts !== 1 ? 's' : ''}${secondAttempts ? `, ${secondAttempts} retry` : ''}`
      : 'No attempts';

    detailedTableRows += `
      <tr style="border-bottom:1px solid #eee;">
        <td style="padding:8px;font-weight:bold;">Table ${tbl}</td>
        <td style="padding:8px;">${modeStr}</td>
        <td style="padding:8px;">${attemptsStr}</td>
        <td style="padding:8px;">${demotions > 0 ? `${demotions}` : 'None'}</td>
        <td style="padding:8px;text-align:right;">${timeStr}${timeCompare}</td>
      </tr>
    `;
  }

  const tableHtml = detailedTableRows ? `
    <table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px;">
      <tr style="background:#f9f9f9;border-bottom:2px solid #ddd;">
        <th style="padding:8px;text-align:left;">Table</th>
        <th style="padding:8px;text-align:left;">Mode Completed</th>
        <th style="padding:8px;text-align:left;">Attempt Breakdown</th>
        <th style="padding:8px;text-align:left;">Demotions</th>
        <th style="padding:8px;text-align:right;">Time</th>
      </tr>
      ${detailedTableRows}
    </table>
  ` : '<p><i>No table progress today.</i></p>';

  const ach = [];
  for (const m of op.modesCompleted) ach.push(`✅ Completed ${MODE_LABEL[m.mode] || m.mode} on Table ${m.table}`);
  for (const t of op.tablesCompleted) ach.push(`🏆 Mastered all 3 modes on Table ${t}!`);
  for (const d of op.demotions) ach.push(`🐌 Demotion on Table ${d.table}`);
  const achHtml = ach.length
    ? ach.map(a => `<li style="margin:4px 0;">${a}</li>`).join('')
    : '<li><i>No achievements today.</i></li>';

  let standing = '<i>No saved progress yet.</i>';
  if (currentState) {
    const cs = currentState;
    standing = `<b>Currently on Table ${cs.currentTable ?? '?'} · ${MODE_LABEL[cs.currentMode] || cs.currentMode || '?'} · ${cs.tableStreak ?? 0}/10 in a row · ${cs.points ?? 0} / 1000 🎮</b>`;
  }

  return `
    <h2 style="color:#764ba2;border-bottom:2px solid #ece8f3;padding-bottom:6px;margin-top:28px;">${name}</h2>
    <p style="margin:6px 0;">${standing}</p>
    <p style="margin:6px 0;"><b>Today:</b> ${op.correct} correct · ${op.wrong} wrong · ${op.timeouts} time-outs · ${acc}% accuracy</p>
    <h3 style="font-size:14px;color:#555;margin:14px 8px 8px;">Table Details</h3>
    ${tableHtml}
    <h3 style="font-size:14px;color:#555;margin:14px 0 4px;">Achievements</h3>
    <ul style="margin:0 0 0 18px;padding:0;">${achHtml}</ul>
  `;
}

function renderEmail(data) {
  const todayPT = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
  const state = data.currentState || {};
  const ms = state.multiplication;
  const ds = state.division;
  const today = data.today;
  const yesterday = data.yesterday;
  const sum = today.summary;
  const playMin = today.playMinutes;
  const yPlayMin = yesterday.playMinutes;
  const totalQ = sum.multiplication.correct + sum.multiplication.wrong
               + sum.division.correct + sum.division.wrong;
  const yTotalQ = yesterday.summary.multiplication.correct + yesterday.summary.multiplication.wrong
                + yesterday.summary.division.correct + yesterday.summary.division.wrong;

  let body;
  if (today.eventCount === 0) {
    const lastM = ms ? `Table ${ms.currentTable} · ${MODE_LABEL[ms.currentMode] || ms.currentMode} · ${ms.tableStreak}/10 · ${ms.points || 0} / 1000 🎮` : 'no progress yet';
    const lastD = ds ? `Table ${ds.currentTable} · ${MODE_LABEL[ds.currentMode] || ds.currentMode} · ${ds.tableStreak}/10 · ${ds.points || 0} / 1000 🎮` : 'no progress yet';
    body = `
      <p style="font-size:16px;">😴 Drohn didn't play today.</p>
      <p style="margin:8px 0;"><b>Yesterday:</b> ~${yPlayMin} minutes · ${yTotalQ} questions</p>
      <h3 style="margin-top:18px;">Last known standing</h3>
      <p><b>Multiplication:</b> ${lastM}<br/><b>Division:</b> ${lastD}</p>
    `;
  } else {
    body = `
      <p style="font-size:16px;"><b>Total play time:</b> ~${playMin} min${fmtDelta(playMin, yPlayMin)}<br/>
      <span style="color:#888;font-size:13px;">Yesterday: ~${yPlayMin} min</span></p>
      <p style="font-size:16px;"><b>Total questions answered:</b> ${totalQ}${fmtDelta(totalQ, yTotalQ)}<br/>
      <span style="color:#888;font-size:13px;">Yesterday: ${yTotalQ} questions</span></p>
      ${renderOpSection('Multiplication ×', sum.multiplication, ms, yesterday.summary.multiplication)}
      ${renderOpSection('Division ÷', sum.division, ds, yesterday.summary.division)}
    `;
  }

  return `<!doctype html><html><body style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#222;max-width:640px;margin:0 auto;padding:20px;background:#fff;">
    <h1 style="color:#5d3a82;margin-bottom:0;">Drohn Raja — Math Practice</h1>
    <p style="color:#888;font-size:13px;margin-top:4px;">${todayPT}</p>
    ${body}
    <hr style="border:none;border-top:1px solid #ddd;margin:28px 0 12px;"/>
    <p style="font-size:11px;color:#aaa;">Sent by Vercel Cron · <a href="https://multiplication-practice-zeta.vercel.app" style="color:#888;">Open the app</a></p>
  </body></html>`;
}

function summarizeRange(allEvents, fromTs, toTs) {
  const slice = allEvents.filter(e => e.ts >= fromTs && e.ts < toTs);
  const summary = { multiplication: emptyOp(), division: emptyOp() };

  // Track per-table details: table start times and completion times
  const tableStartTimes = {}; // { 'op_table': timestamp }
  const tableCompletionTimes = {}; // { 'op_table': seconds }

  for (const e of slice) {
    const op = e.op === 'division' ? 'division' : 'multiplication';
    const s = summary[op];
    const tableKey = `${op}_${e.table}`;

    if (e.type === 'correct') {
      s.correct++;
      s.questions++;
      bumpTable(s, e.table, e.mode, 'correct');
      // Track first attempt vs second attempt
      if (!s.byTable[String(e.table)].firstAttempts) s.byTable[String(e.table)].firstAttempts = 0;
      if (!s.byTable[String(e.table)].secondAttempts) s.byTable[String(e.table)].secondAttempts = 0;
      if (e.firstAttempt) {
        s.byTable[String(e.table)].firstAttempts++;
      } else {
        s.byTable[String(e.table)].secondAttempts++;
      }
    } else if (e.type === 'wrong') {
      s.wrong++;
      s.questions++;
      bumpTable(s, e.table, e.mode, 'wrong');
    } else if (e.type === 'timeout') {
      s.timeouts++;
      s.wrong++;
      s.questions++;
      bumpTable(s, e.table, e.mode, 'wrong');
    } else if (e.type === 'table-start') {
      if (!tableStartTimes[tableKey]) {
        tableStartTimes[tableKey] = e.ts;
      }
    } else if (e.type === 'table-complete') {
      if (tableStartTimes[tableKey] && !tableCompletionTimes[tableKey]) {
        const elapsed = Math.round((e.ts - tableStartTimes[tableKey]) / 1000);
        tableCompletionTimes[tableKey] = elapsed;
        // Store completion time in the table data
        if (!s.byTable[String(e.table)]) s.byTable[String(e.table)] = { correct: 0, wrong: 0, byMode: {} };
        s.byTable[String(e.table)].completionTime = elapsed;
      }
    } else if (e.type === 'mode-complete') {
      s.modesCompleted.push({ table: e.table, mode: e.mode });
      // Track completed mode per table
      if (!s.byTable[String(e.table)]) s.byTable[String(e.table)] = { correct: 0, wrong: 0, byMode: {} };
      if (e.mode === 'cheetah') {
        s.byTable[String(e.table)].completedMode = 'cheetah';
      }
    } else if (e.type === 'cheetah-strike' && e.strikeNumber === 2) {
      // Strike 2 = table reset (counts as a demotion for reporting)
      s.demotions.push({ table: e.table, strikeType: 'strike-2', description: 'Table reset to problem 1' });
      // Track demotions per table
      if (!s.byTable[String(e.table)]) s.byTable[String(e.table)] = { correct: 0, wrong: 0, byMode: {} };
      if (!s.byTable[String(e.table)].demotions) s.byTable[String(e.table)].demotions = 0;
      s.byTable[String(e.table)].demotions++;
    } else if (e.type === 'cheetah-demote') {
      s.demotions.push({ table: e.table, fromMode: 'cheetah', toMode: e.toMode || 'snail', pointsLost: e.pointsLost || 0 });
      // Track demotions per table
      if (!s.byTable[String(e.table)]) s.byTable[String(e.table)] = { correct: 0, wrong: 0, byMode: {} };
      if (!s.byTable[String(e.table)].demotions) s.byTable[String(e.table)].demotions = 0;
      s.byTable[String(e.table)].demotions++;
    }
  }

  return {
    eventCount: slice.length,
    playMinutes: computePlayMinutes(slice),
    summary
  };
}

async function buildSummary(hours) {
  const stateRes = await redis(['GET', 'state:drohn']);
  const eventsRes = await redis(['LRANGE', 'events:drohn', '0', '19999']);

  const state = stateRes && stateRes.result ? JSON.parse(stateRes.result) : null;
  const allEvents = ((eventsRes && eventsRes.result) || [])
    .map(e => { try { return JSON.parse(e); } catch (err) { return null; } })
    .filter(Boolean);

  const now = Date.now();
  const windowMs = hours * 60 * 60 * 1000;

  const today = summarizeRange(allEvents, now - windowMs, now);
  const yesterday = summarizeRange(allEvents, now - 2 * windowMs, now - windowMs);

  return {
    hours,
    today,
    yesterday,
    currentState: state,
    // Back-compat: top-level fields still mirror "today" for any older renderers
    eventCount: today.eventCount,
    playMinutes: today.playMinutes,
    summary: today.summary
  };
}

function fmtDelta(today, yesterday) {
  if (yesterday === 0 && today === 0) return '';
  if (yesterday === 0) return ' <span style="color:#2e8b57;">(first day!)</span>';
  const pct = ((today - yesterday) / yesterday) * 100;
  if (Math.abs(pct) < 1) return ' <span style="color:#888;">(same as yesterday)</span>';
  const arrow = pct > 0 ? '▲' : '▼';
  const color = pct > 0 ? '#2e8b57' : '#c0392b';
  return ` <span style="color:${color};">${arrow} ${Math.abs(pct).toFixed(0)}% vs yesterday</span>`;
}

export default async function handler(req, res) {
  // Auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET> automatically.
  // Manual testing can use ?secret=<CRON_SECRET>.
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
    const hours = Number(req.query.hours || 24);
    const data = await buildSummary(hours);
    const html = renderEmail(data);

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

    return res.status(200).json({ ok: true, sentTo: RECIPIENTS, eventCount: data.eventCount });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
