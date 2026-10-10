const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { db, logEvent } = require('./db');
const {
  startCron,
  sendTelegramMessage,
  checkCommits,
  checkRepoCommits,
  sendReminders,
  getIntSetting,
} = require('./cron');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- helpers ----------
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

// Optional shared secret so random hosts can't ring the PC alarm or
// poke the settings API. Leave DAEMON_TOKEN unset to skip auth.
function checkAuth(req, res, next) {
  const want = process.env.DAEMON_TOKEN;
  if (!want) return next();
  const got = req.query.token || req.headers['x-daemon-token'];
  if (got !== want) return res.status(403).json({ error: 'forbidden' });
  next();
}

function ghHeaders() {
  const headers = { 'User-Agent': 'dev-command-center/1.0', Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || getSetting('github_token');
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function fmtDT(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function taskWithLinks(row) {
  return row;
}

// ---------- health ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- tasks ----------
const TASK_SELECT = `
  SELECT t.*,
         p.title AS project_title,
         r.owner AS repo_owner, r.name AS repo_name
  FROM tasks t
  LEFT JOIN tasks p ON p.id = t.project_id
  LEFT JOIN repos r ON r.id = t.repo_id
`;

app.get('/api/tasks', (req, res) => {
  res.json(db.prepare(`${TASK_SELECT} ORDER BY t.completed, t.id DESC`).all());
});

app.post('/api/tasks', async (req, res) => {
  const { title, category, due_at, reminder_minutes, project_id, repo_id } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
  const cat = ['project', 'plan'].includes(category) ? category : 'project';

  // validate associations
  let pid = null;
  if (project_id) {
    const p = db.prepare("SELECT id FROM tasks WHERE id = ? AND category = 'project'").get(project_id);
    if (!p) return res.status(400).json({ error: 'linked project not found' });
    pid = project_id;
  }
  let rid = null;
  if (repo_id) {
    const r = db.prepare('SELECT id FROM repos WHERE id = ?').get(repo_id);
    if (!r) return res.status(400).json({ error: 'linked repo not found' });
    rid = repo_id;
  }

  const mins = Number.isFinite(+reminder_minutes) && +reminder_minutes > 0 ? Math.floor(+reminder_minutes) : null;
  const interval = mins || getIntSetting('default_reminder_minutes', 60);
  const nextReminder = fmtDT(new Date(Date.now() + interval * 60 * 1000));

  const info = db
    .prepare(
      `INSERT INTO tasks (title, category, due_at, reminder_minutes, next_reminder_at, project_id, repo_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(title.trim(), cat, due_at || null, mins, nextReminder, pid, rid);

  const created = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(info.lastInsertRowid);

  // notify Telegram — in future this same path can target a team channel
  const linkBit = created.project_title
    ? `\n🔗 Project: ${created.project_title}`
    : created.repo_owner
      ? `\n🔗 Repo: ${created.repo_owner}/${created.repo_name}`
      : '';
  const dueBit = due_at ? `\n🕒 Due: ${due_at}` : '';
  sendTelegramMessage(
    `📝 <b>New ${cat}:</b> ${title.trim()}${linkBit}${dueBit}\n_reminders every ${interval}m_`
  ).catch(() => {});
  logEvent('task', `Created ${cat}: "${title.trim()}"`);

  res.json(created);
});

app.patch('/api/tasks/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });

  const { completed, title, due_at, reminder_minutes, project_id, repo_id } = req.body;
  const updates = [];
  const params = [];

  if (typeof completed === 'boolean') {
    updates.push('completed = ?');
    params.push(completed ? 1 : 0);
    if (!completed) {
      // re-arm reminders when reopening
      const interval = t.reminder_minutes || getIntSetting('default_reminder_minutes', 60);
      updates.push('next_reminder_at = ?');
      params.push(fmtDT(new Date(Date.now() + interval * 60 * 1000)));
    }
  }
  if (typeof title === 'string' && title.trim()) { updates.push('title = ?'); params.push(title.trim()); }
  if (due_at !== undefined) { updates.push('due_at = ?'); params.push(due_at || null); }
  if (reminder_minutes !== undefined) {
    const mins = Number.isFinite(+reminder_minutes) && +reminder_minutes > 0 ? Math.floor(+reminder_minutes) : null;
    updates.push('reminder_minutes = ?');
    params.push(mins);
    if (mins && !t.completed) {
      updates.push('next_reminder_at = ?');
      params.push(fmtDT(new Date(Date.now() + mins * 60 * 1000)));
    }
  }
  if (project_id !== undefined) {
    if (project_id) {
      const p = db.prepare("SELECT id FROM tasks WHERE id = ? AND category = 'project'").get(project_id);
      if (!p) return res.status(400).json({ error: 'linked project not found' });
    }
    updates.push('project_id = ?');
    params.push(project_id || null);
  }
  if (repo_id !== undefined) {
    if (repo_id) {
      const r = db.prepare('SELECT id FROM repos WHERE id = ?').get(repo_id);
      if (!r) return res.status(400).json({ error: 'linked repo not found' });
    }
    updates.push('repo_id = ?');
    params.push(repo_id || null);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(req.params.id));
});

app.delete('/api/tasks/:id', (req, res) => {
  // manual cascade: plans linked to this project go with it
  // (covers DBs created before FK enforcement)
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(req.params.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------- repo connectors ----------
app.get('/api/repos', (req, res) => {
  const repos = db.prepare('SELECT * FROM repos ORDER BY id').all();
  const counts = db
    .prepare("SELECT repo_id, COUNT(*) AS n FROM tasks WHERE repo_id IS NOT NULL AND completed = 0 GROUP BY repo_id")
    .all();
  const byRepo = Object.fromEntries(counts.map((c) => [c.repo_id, c.n]));
  res.json(repos.map((r) => ({ ...r, open_plans: byRepo[r.id] || 0 })));
});

app.post('/api/repos', async (req, res) => {
  const { owner, name } = req.body;
  if (!owner || !name) return res.status(400).json({ error: 'owner and name required' });
  const o = owner.trim();
  const n = name.trim();

  // validate the repo actually exists on GitHub before accepting it
  let gh;
  try {
    const r = await axios.get(`https://api.github.com/repos/${o}/${n}`, {
      headers: ghHeaders(),
      timeout: 15000,
    });
    gh = r.data;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({ error: `repo ${o}/${n} does not exist on GitHub` });
    }
    return res.status(502).json({ error: `GitHub lookup failed: ${err.message}` });
  }

  try {
    const info = db.prepare('INSERT INTO repos (owner, name) VALUES (?, ?)').run(o, n);
    const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(info.lastInsertRowid);
    // seed latest commit info immediately so the card isn't empty
    try {
      await checkRepoCommits(repo);
    } catch (e) {
      console.error('initial commit seed failed:', e.message);
    }
    const fresh = db.prepare('SELECT * FROM repos WHERE id = ?').get(info.lastInsertRowid);
    logEvent('repo', `Watching ${o}/${n}${gh.description ? ` — ${gh.description.slice(0, 80)}` : ''}`);
    res.json(fresh);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'repo already watched' });
    throw e;
  }
});

app.delete('/api/repos/:id', (req, res) => {
  // manual cascade: plans linked to this repo go with it
  db.prepare('DELETE FROM tasks WHERE repo_id = ?').run(req.params.id);
  db.prepare('DELETE FROM repos WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// per-repo status check (the button beside each repo)
app.post('/api/repos/:id/check', async (req, res) => {
  const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id);
  if (!repo) return res.status(404).json({ error: 'repo not found' });
  try {
    const result = await checkRepoCommits(repo);
    const fresh = db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id);
    res.json({ success: true, newCommits: result.newCommits, repo: fresh });
  } catch (err) {
    const code = err.response ? err.response.status : 'network';
    db.prepare('UPDATE repos SET status = ?, last_checked_at = ? WHERE id = ?').run(
      `error (${code})`,
      fmtDT(new Date()),
      req.params.id
    );
    res.json({ success: false, error: `GitHub check failed (${code}): ${err.message}` });
  }
});

// global check-now (kept from v1)
app.post('/api/repos/check-now', async (req, res) => {
  await checkCommits();
  res.json({ success: true });
});

// ---------- github connection test ----------
app.post('/api/github/test', async (req, res) => {
  try {
    const r = await axios.get('https://api.github.com/rate_limit', { headers: ghHeaders(), timeout: 15000 });
    const core = r.data.resources.core;
    const resetAt = new Date(core.reset * 1000).toLocaleString();
    res.json({
      success: true,
      message: `GitHub API reachable — ${core.remaining}/${core.limit} requests remaining (resets ${resetAt})`,
      remaining: core.remaining,
      limit: core.limit,
    });
  } catch (err) {
    const code = err.response ? err.response.status : 'network';
    res.json({ success: false, error: `GitHub unreachable (${code}): ${err.message}` });
  }
});

// ---------- activity feed ----------
app.get('/api/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all());
});

// ---------- settings ----------
const SETTING_KEYS = [
  'tg_bot_token',
  'tg_chat_id',
  'github_token',
  'quiet_start',
  'quiet_end',
  'default_reminder_minutes',
];

app.get('/api/settings', checkAuth, (req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) {
    const v = getSetting(k);
    out[k] = k.includes('token') && v ? '***set***' : v;
  }
  res.json(out);
});

app.put('/api/settings', checkAuth, (req, res) => {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const key of SETTING_KEYS) {
    if (req.body[key] !== undefined && req.body[key] !== null) {
      stmt.run(key, String(req.body[key]).trim());
    }
  }
  res.json({ success: true });
});

// ---------- telegram test ----------
app.post('/api/telegram/test', async (req, res) => {
  const { message } = req.body;
  const sent = await sendTelegramMessage(
    message || '🧪 Test ping from <b>Developer Command Center</b> — Telegram is wired up.'
  );
  if (sent) logEvent('telegram', 'Manual Telegram test ping sent');
  res.json({ success: sent, error: sent ? undefined : 'Telegram not configured (bot token / chat id missing)' });
});

// ---------- PC alarm daemon bridge ----------
let alarmTriggered = false;

app.get('/api/daemon/check-alarm', checkAuth, (req, res) => {
  res.json({ sound_alarm: alarmTriggered });
  alarmTriggered = false; // consume
});

app.post('/api/daemon/trigger-alarm', checkAuth, (req, res) => {
  alarmTriggered = true;
  logEvent('alarm', 'PC alarm triggered from dashboard');
  res.json({ success: true });
});

app.post('/api/reminders/send-now', checkAuth, async (req, res) => {
  const r = await sendReminders();
  if (r.quiet) return res.json({ success: true, quiet: true, message: 'in quiet hours — deferred' });
  res.json({ success: true, sent: r.sent });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Developer Command Center backend listening on :${PORT}`);
  startCron();
});
