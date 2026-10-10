const express = require('express');
const cors = require('cors');
const { db, logEvent } = require('./db');
const { startCron, sendTelegramMessage, checkCommits, sendReminders } = require('./cron');

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

// ---------- health ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- tasks ----------
app.get('/api/tasks', (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks ORDER BY completed, id DESC').all());
});

app.post('/api/tasks', (req, res) => {
  const { title, category } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });
  const cat = ['project', 'plan'].includes(category) ? category : 'project';
  const info = db.prepare('INSERT INTO tasks (title, category) VALUES (?, ?)').run(title.trim(), cat);
  res.json({ id: info.lastInsertRowid, title: title.trim(), category: cat, completed: 0 });
});

app.patch('/api/tasks/:id', (req, res) => {
  const { completed } = req.body;
  const result = db.prepare('UPDATE tasks SET completed = ? WHERE id = ?').run(completed ? 1 : 0, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ success: true });
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------- repo connectors ----------
app.get('/api/repos', (req, res) => {
  res.json(db.prepare('SELECT * FROM repos ORDER BY id').all());
});

app.post('/api/repos', (req, res) => {
  const { owner, name } = req.body;
  if (!owner || !name) return res.status(400).json({ error: 'owner and name required' });
  try {
    const info = db.prepare('INSERT INTO repos (owner, name) VALUES (?, ?)').run(owner.trim(), name.trim());
    res.json({ id: info.lastInsertRowid, owner: owner.trim(), name: name.trim(), last_commit_sha: null });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'repo already watched' });
    throw e;
  }
});

app.delete('/api/repos/:id', (req, res) => {
  db.prepare('DELETE FROM repos WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Manual commit-check trigger (also useful for the "check now" button)
app.post('/api/repos/check-now', async (req, res) => {
  await checkCommits();
  res.json({ success: true });
});

// ---------- activity feed ----------
app.get('/api/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all());
});

// ---------- settings ----------
app.get('/api/settings', checkAuth, (req, res) => {
  res.json({
    tg_bot_token: getSetting('tg_bot_token') ? '***set***' : null,
    tg_chat_id: getSetting('tg_chat_id'),
    github_token: getSetting('github_token') ? '***set***' : null,
  });
});

app.put('/api/settings', checkAuth, (req, res) => {
  const allow = ['tg_bot_token', 'tg_chat_id', 'github_token'];
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const key of allow) {
    if (typeof req.body[key] === 'string') stmt.run(key, req.body[key].trim());
  }
  res.json({ success: true });
});

// ---------- telegram test ----------
app.post('/api/telegram/test', async (req, res) => {
  const { message } = req.body;
  const sent = await sendTelegramMessage(message || '🧪 Test ping from <b>Developer Command Center</b> — Telegram is wired up.');
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
  await sendReminders();
  res.json({ success: true });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Developer Command Center backend listening on :${PORT}`);
  startCron();
});
