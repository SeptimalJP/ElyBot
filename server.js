/**
 * EQ2 Attendance Tracker — Node.js + Discord Bot + Web UI (single file)
 * ----------------------------------------------------------------------
 * Features
 * - Discord bot samples a specific voice channel hourly (on the hour) and logs who is present.
 * - Web dashboard shows This Month % and Last Month % attendance per member.
 * - Highlights who is below 75% (yellow) and 50% (red).
 * - Simple role management (Raider/Reserve) via the UI.
 *
 * Quick Start
 * 1) `npm init -y`
 * 2) `npm i express discord.js better-sqlite3 node-cron dayjs dotenv`
 * 3) Create a `.env` file with:
 *      DISCORD_TOKEN=your_bot_token
 *      GUILD_ID=123456789012345678
 *      VOICE_CHANNEL_ID=123456789012345678
 *      PORT=3000
 * 4) Enable Privileged Gateway Intents for your bot in the Discord Developer Portal:
 *      - SERVER MEMBERS INTENT (optional if you want names)
 *      - PRESENCE INTENT (not required here)
 *      - GUILD VOICE STATES (REQUIRED)
 * 5) Invite the bot to your server with the scopes/permissions it needs.
 * 6) Run: `node server.js` (rename this file to server.js)
 * 7) Open http://localhost:3000
 *
 * Attendance Definition
 * - For each hourly snapshot where the target voice channel is sampled, 
 *   a member gets 1 credit if present at that snapshot. 
 * - A member's monthly attendance % = (snapshots present this month) / (total snapshots taken this month).
 * - "Last Month %" uses the same definition but for the previous calendar month.
 */

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const dayjs = require('dayjs');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

// ---------------------- Config ----------------------
const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

if (!DISCORD_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('Missing required env vars. Please set DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID in .env');
}

// ---------------------- DB Setup ----------------------
const db = new Database('attendance.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS members (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT DEFAULT 'Raider', -- 'Raider' | 'Reserve'
  first_seen INTEGER,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- Unix millis
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presence (
  snapshot_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, user_id),
  FOREIGN KEY(snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);
`);

const insertSnapshot = db.prepare('INSERT INTO snapshots (ts, guild_id, channel_id) VALUES (?, ?, ?)');
const insertPresence = db.prepare('INSERT OR IGNORE INTO presence (snapshot_id, user_id) VALUES (?, ?)');
const upsertMember = db.prepare(`
  INSERT INTO members (user_id, display_name, role, first_seen, last_seen)
  VALUES (@user_id, @display_name, COALESCE(@role,'Raider'), @ts, @ts)
  ON CONFLICT(user_id) DO UPDATE SET
    display_name=excluded.display_name,
    last_seen=excluded.last_seen
`);

// ---------------------- Discord Bot ----------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers, // helpful for names
  ],
  partials: [Partials.GuildMember]
});

client.once('ready', async () => {
  console.log(`Discord bot ready as ${client.user.tag}`);
  // Start cron scheduling after the bot is ready
  startScheduling();
  // Take an immediate snapshot once the bot is ready
  sampleVoiceChannel();
});

async function sampleVoiceChannel() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);
    if (!channel || !channel.isVoiceBased?.()) {
      console.warn('Configured VOICE_CHANNEL_ID is not a voice channel or not found.');
      return;
    }

    // Collect current members in the voice channel
    const members = channel.members; // Collection of GuildMember
    const ts = Date.now();

    const insert = db.transaction(() => {
      const info = insertSnapshot.run(ts, GUILD_ID, VOICE_CHANNEL_ID);
      const snapshotId = info.lastInsertRowid;

      for (const [, gm] of members) {
        const userId = gm.user.id;
        const displayName = gm.displayName || gm.user.username || userId;
        upsertMember.run({ user_id: userId, display_name: displayName, role: 'Raider', ts });
        insertPresence.run(snapshotId, userId);
      }
    });

    insert();
    console.log(`[${new Date().toISOString()}] Snapshot saved. Present: ${members.size}`);
  } catch (err) {
    console.error('Error sampling voice channel:', err);
  }
}

// Schedule: top of every hour
function startScheduling(){
  cron.schedule('0 * * * *', () => {
    console.log('Cron: sampling voice channel');
    sampleVoiceChannel();
  });
}

// (Sampling is kicked off after the bot is ready)

// ---------------------- Attendance Calculations ----------------------
function monthBounds(ym) {
  // ym format: 'YYYY-MM'; if null, use current month
  const base = ym ? dayjs(ym + '-01') : dayjs();
  const start = base.startOf('month');
  const end = base.endOf('month');
  return { startMs: start.valueOf(), endMs: end.valueOf() };
}

function lastMonthYM(ym) {
  const base = ym ? dayjs(ym + '-01') : dayjs();
  return base.subtract(1, 'month').format('YYYY-MM');
}

const qTotalSnapshotsInRange = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM snapshots
  WHERE ts BETWEEN ? AND ? AND channel_id = ? AND guild_id = ?
`);

const qPresenceCountsInRange = db.prepare(`
  SELECT p.user_id, COUNT(*) AS present
  FROM presence p
  JOIN snapshots s ON s.id = p.snapshot_id
  WHERE s.ts BETWEEN ? AND ? AND s.channel_id = ? AND s.guild_id = ?
  GROUP BY p.user_id
`);

const qMembers = db.prepare(`SELECT user_id, display_name, role FROM members`);

function computeAttendance(ym) {
  const { startMs, endMs } = monthBounds(ym);
  const total = qTotalSnapshotsInRange.get(startMs, endMs, VOICE_CHANNEL_ID, GUILD_ID).cnt;
  const presentRows = qPresenceCountsInRange.all(startMs, endMs, VOICE_CHANNEL_ID, GUILD_ID);
  const map = new Map(presentRows.map(r => [r.user_id, r.present]));
  return { total, presentMap: map };
}

function summaryPayload(ymCurrent) {
  const ym = ymCurrent || dayjs().format('YYYY-MM');
  const ymPrev = lastMonthYM(ym);

  const thisMonth = computeAttendance(ym);
  const lastMonth = computeAttendance(ymPrev);

  const members = qMembers.all();

  const rows = members.map(m => {
    const presentThis = thisMonth.presentMap.get(m.user_id) || 0;
    const presentLast = lastMonth.presentMap.get(m.user_id) || 0;
    const pctThis = thisMonth.total ? presentThis / thisMonth.total : null;
    const pctLast = lastMonth.total ? presentLast / lastMonth.total : null;
    return {
      userId: m.user_id,
      name: m.display_name || m.user_id,
      role: m.role || 'Raider',
      thisMonth: { ym, present: presentThis, total: thisMonth.total, pct: pctThis },
      lastMonth: { ym: ymPrev, present: presentLast, total: lastMonth.total, pct: pctLast },
      flags: {
        under50: pctThis !== null && pctThis < 0.5,
        under75: pctThis !== null && pctThis < 0.75
      }
    };
  });

  // Sort by pct desc (this month)
  rows.sort((a,b) => (b.thisMonth.pct ?? -1) - (a.thisMonth.pct ?? -1));

  return {
    ym,
    ymPrev,
    totals: { thisMonth: thisMonth.total, lastMonth: lastMonth.total },
    rows,
    below50: rows.filter(r => r.flags.under50).map(r => r.name),
    below75: rows.filter(r => r.flags.under75 && !r.flags.under50).map(r => r.name)
  };
}

// ---------------------- Web Server ----------------------
const app = express();
app.use(express.json());

// Serve UI
app.get('/', (req, res) => {
  res.type('html').send(renderHTML());
});

// API: summary
app.get('/api/summary', (req, res) => {
  const ym = (req.query.month || '').toString().trim() || undefined; // format YYYY-MM
  const data = summaryPayload(ym);
  res.json(data);
});

// API: set role
app.post('/api/members/role', (req, res) => {
  const { userId, role } = req.body || {};
  if (!userId || !role || !['Raider','Reserve'].includes(role)) {
    return res.status(400).json({ error: 'Provide userId and role in {Raider, Reserve}' });
  }
  db.prepare('UPDATE members SET role=? WHERE user_id=?').run(role, userId);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Web UI: http://localhost:${PORT}`));

// ---------------------- HTML UI ----------------------
function renderHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EQ2 Attendance Tracker</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#0b1020; --card:#121935; --text:#e7ecff; --muted:#9aa7d9; --accent:#7ea8ff; --warn:#ffe08a; --danger:#ff8a8a; }
    *{ box-sizing:border-box; }
    body{ margin:0; font-family:Inter, system-ui, -apple-system, Segoe UI, Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Apple Color Emoji', 'Segoe UI Emoji'; background:linear-gradient(180deg, #0b1020, #11173a); color:var(--text); }
    header{ padding:24px; border-bottom:1px solid #1f254b; display:flex; align-items:center; gap:16px; }
    header h1{ margin:0; font-size:20px; font-weight:700; }
    main{ padding:24px; max-width:1200px; margin:0 auto; display:grid; grid-template-columns: 2fr 1fr; gap:24px; }
    .card{ background:var(--card); border:1px solid #1c2450; border-radius:16px; padding:16px; box-shadow:0 10px 30px rgba(0,0,0,.25); }
    .row{ display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    label{ font-size:12px; color:var(--muted); }
    select, input, button{ background:#0f1533; color:var(--text); border:1px solid #26306b; padding:8px 10px; border-radius:10px; }
    button{ cursor:pointer; }
    table{ width:100%; border-collapse:separate; border-spacing:0 8px; }
    th, td{ text-align:left; padding:10px 12px; font-size:14px; }
    th{ color:var(--muted); font-weight:600; }
    tr{ background:#0f1533; border:1px solid #26306b; }
    tr td:first-child, tr th:first-child{ border-top-left-radius:10px; border-bottom-left-radius:10px; }
    tr td:last-child, tr th:last-child{ border-top-right-radius:10px; border-bottom-right-radius:10px; }
    .pill{ padding:4px 8px; border-radius:999px; font-size:12px; border:1px solid #2a356e; color:#bcd0ff; }
    .pill.warn{ background:rgba(255,224,138,.12); border-color:#6b5a2a; color:#ffe08a; }
    .pill.danger{ background:rgba(255,138,138,.12); border-color:#6b2a2a; color:#ff9a9a; }
    .list{ display:flex; flex-direction:column; gap:8px; }
    .list .item{ background:#0f1533; padding:10px 12px; border:1px solid #26306b; border-radius:10px; }
    footer{ text-align:center; color:#7f8ac2; padding:18px; font-size:12px; }
    canvas{ background:#0f1533; border-radius:12px; border:1px solid #26306b; padding:10px; }
  </style>
</head>
<body>
  <header>
    <h1>EQ2 Attendance Tracker</h1>
    <div class="row">
      <label for="month">Month</label>
      <input id="month" type="month" />
      <button id="refresh">Refresh</button>
    </div>
  </header>

  <main>
    <section class="card">
      <h3 style="margin:8px 0 16px 0;">This Month Attendance</h3>
      <canvas id="chart" height="140"></canvas>
      <div style="margin-top:16px; color:var(--muted); font-size:12px;">Bars are colored by threshold: <span class="pill">OK</span> <span class="pill warn">&lt;75%</span> <span class="pill danger">&lt;50%</span></div>
    </section>

    <aside class="card">
      <h3 style="margin:8px 0 12px 0;">Below Threshold</h3>
      <div class="row" style="gap:24px; align-items:flex-start;">
        <div style="flex:1;">
          <div class="pill danger">Below 50%</div>
          <div id="below50" class="list" style="margin-top:8px;"></div>
        </div>
        <div style="flex:1;">
          <div class="pill warn">50%–75%</div>
          <div id="below75" class="list" style="margin-top:8px;"></div>
        </div>
      </div>

      <h3 style="margin:16px 0 8px 0;">Set Role</h3>
      <div class="row">
        <select id="memberSelect"></select>
        <select id="roleSelect">
          <option>Raider</option>
          <option>Reserve</option>
        </select>
        <button id="saveRole">Save</button>
      </div>
    </aside>

    <section class="card" style="grid-column:1 / -1;">
      <h3 style="margin:8px 0 16px 0;">Roster</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>This Month</th>
            <th>Last Month</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </section>
  </main>

  <footer>Sampling runs hourly at :00 for the configured voice channel. Keep the bot online.</footer>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    const tbody = document.getElementById('tbody');
    const below50El = document.getElementById('below50');
    const below75El = document.getElementById('below75');
    const memberSelect = document.getElementById('memberSelect');
    const roleSelect = document.getElementById('roleSelect');
    const monthInput = document.getElementById('month');
    const refreshBtn = document.getElementById('refresh');
    let chart;

    function fmtPct(p){ return p==null? '—' : (p*100).toFixed(0) + '%'; }

    async function loadSummary() {
      const ym = monthInput.value; // YYYY-MM
      const url = ym ? '/api/summary?month=' + ym : '/api/summary';
      const res = await fetch(url);
      const data = await res.json();
      render(data);
    }

    function render(data){
      // Table
      tbody.innerHTML = '';
      memberSelect.innerHTML = '';
      data.rows.forEach(r => {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); td1.textContent = r.name; tr.appendChild(td1);
        const td2 = document.createElement('td'); td2.textContent = r.role; tr.appendChild(td2);
        const td3 = document.createElement('td'); td3.textContent = fmtPct(r.thisMonth.pct) + ' (' + r.thisMonth.present + '/' + (r.thisMonth.total || 0) + ')'; tr.appendChild(td3);
        const td4 = document.createElement('td'); td4.textContent = fmtPct(r.lastMonth.pct) + ' (' + r.lastMonth.present + '/' + (r.lastMonth.total || 0) + ')'; tr.appendChild(td4);
        if (r.flags.under50) tr.style.outline = '2px solid rgba(255,138,138,.5)';
        else if (r.flags.under75) tr.style.outline = '2px solid rgba(255,224,138,.5)';
        tbody.appendChild(tr);

        const opt = document.createElement('option');
        opt.value = r.userId; opt.textContent = r.name; memberSelect.appendChild(opt);
      });

      // Below lists
      below50El.innerHTML = data.below50.length ? '' : '<div class="item">— none —</div>';
      data.below50.forEach(n => { const d=document.createElement('div'); d.className='item'; d.textContent=n; below50El.appendChild(d); });
      below75El.innerHTML = data.below75.length ? '' : '<div class="item">— none —</div>';
      data.below75.forEach(n => { const d=document.createElement('div'); d.className='item'; d.textContent=n; below75El.appendChild(d); });

      // Chart
      const labels = data.rows.map(r => r.name);
      const values = data.rows.map(r => r.thisMonth.pct==null?0:r.thisMonth.pct*100);
      const colors = data.rows.map(r => r.flags.under50? 'rgba(255,138,138,0.8)': r.flags.under75? 'rgba(255,224,138,0.8)':'rgba(126,168,255,0.9)');
      if (chart) chart.destroy();
      const ctx = document.getElementById('chart').getContext('2d');
      chart = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'This Month (' + data.ym + ')' , data: values, backgroundColor: colors }] },
        options: {
          scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } },
          plugins: { legend: { display: false } }
        }
      });
    }

    document.getElementById('saveRole').addEventListener('click', async () => {
      const userId = memberSelect.value;
      const role = roleSelect.value;
      if (!userId) return;
      await fetch('/api/members/role', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId, role })});
      await loadSummary();
    });

    refreshBtn.addEventListener('click', loadSummary);

    // Default month = current
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth()+1).padStart(2,'0');
    monthInput.value = y + '-' + m;

    loadSummary();
  </script>
</body>
</html>`;
}
