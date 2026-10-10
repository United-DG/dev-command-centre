const cron = require('node-cron');
const axios = require('axios');
const { db, logEvent } = require('./db');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function tgConfig() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || getSetting('tg_bot_token'),
    chatId: process.env.TELEGRAM_CHAT_ID || getSetting('tg_chat_id'),
  };
}

async function sendTelegramMessage(text) {
  const { botToken, chatId } = tgConfig();
  if (!botToken || !chatId) {
    console.warn('Telegram not configured — skipping message');
    return false;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
      { timeout: 15000 }
    );
    return true;
  } catch (err) {
    console.error('Telegram dispatch error:', err.message);
    return false;
  }
}

function githubHeaders() {
  const headers = { 'User-Agent': 'dev-command-center/1.0', Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || getSetting('github_token');
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function getIntSetting(key, fallback) {
  const v = getSetting(key);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- quiet hours (server local time) ----------
// quiet_start / quiet_end are hours 0-23. e.g. 22 -> 7 means quiet 22:00-07:00.
// If start == end, quiet hours are disabled.
function inQuietHours(now) {
  const start = getIntSetting('quiet_start', -1);
  const end = getIntSetting('quiet_end', -1);
  if (start < 0 || end < 0 || start === end) return false;
  const h = now.getHours() + now.getMinutes() / 60;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end; // wraps midnight
}

// Next clock time when quiet hours end (Date in the future)
function quietEndsAt(now) {
  const start = getIntSetting('quiet_start', -1);
  const end = getIntSetting('quiet_end', -1);
  const d = new Date(now);
  d.setSeconds(0, 0);
  if (start < end) {
    d.setHours(end, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
  } else {
    // wraps midnight: quiet until `end` today if we're past midnight, else tomorrow
    d.setHours(end, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
  }
  return d;
}

function fmtDT(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- per-task reminders ----------
async function sendDueReminders() {
  const now = new Date();
  const nowStr = fmtDT(now);
  const due = db
    .prepare(
      `SELECT * FROM tasks WHERE completed = 0
       AND next_reminder_at IS NOT NULL AND next_reminder_at <= ?
       ORDER BY next_reminder_at`
    )
    .all(nowStr);

  for (const t of due) {
    const intervalMin = t.reminder_minutes || getIntSetting('default_reminder_minutes', 60);

    if (inQuietHours(now)) {
      // defer until quiet hours end — don't spam the night
      const wake = quietEndsAt(now);
      db.prepare('UPDATE tasks SET next_reminder_at = ? WHERE id = ?').run(fmtDT(wake), t.id);
      continue;
    }

    const dueBit = t.due_at ? `\n🕒 Due: ${t.due_at}` : '';
    const sent = await sendTelegramMessage(
      `🔔 <b>Reminder: ${t.title}</b>\n[${t.category}]${dueBit}\n\n_mark done in the dashboard when finished_`
    );
    const next = new Date(now.getTime() + intervalMin * 60 * 1000);
    db.prepare('UPDATE tasks SET next_reminder_at = ? WHERE id = ?').run(fmtDT(next), t.id);
    if (sent) logEvent('reminder', `Reminded about "${t.title}" (next in ${intervalMin}m)`);
  }
}

// ---------- github commit watcher ----------
async function checkRepoCommits(repo) {
  const res = await axios.get(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/commits?per_page=5`,
    { headers: githubHeaders(), timeout: 15000 }
  );
  const commits = res.data;
  const nowStr = fmtDT(new Date());

  if (!Array.isArray(commits) || commits.length === 0) {
    db.prepare('UPDATE repos SET status = ?, last_checked_at = ? WHERE id = ?').run('ok', nowStr, repo.id);
    return { newCommits: 0 };
  }

  const newOnes = [];
  for (const c of commits) {
    if (c.sha === repo.last_commit_sha) break;
    newOnes.push(c);
  }
  for (const c of newOnes.reverse()) {
    const short = c.sha.slice(0, 7);
    const msg = (c.commit && c.commit.message ? c.commit.message : '').split('\n')[0];
    const author = (c.commit && c.commit.author && c.commit.author.name) || 'unknown';
    await sendTelegramMessage(
      `🚀 <b>New commit in ${repo.owner}/${repo.name}</b>\n\n<code>${short}</code> — ${msg}\nby ${author}`
    );
    logEvent('commit', `${short} [${repo.owner}/${repo.name}] ${msg}`);
  }

  const latest = commits[0];
  const latestAt =
    (latest.commit && latest.commit.author && latest.commit.author.date) ||
    (latest.commit && latest.commit.committer && latest.commit.committer.date) ||
    null;
  db.prepare(
    `UPDATE repos SET last_commit_sha = ?, last_commit_msg = ?, last_commit_at = ?,
     status = 'ok', last_checked_at = ? WHERE id = ?`
  ).run(
    latest.sha,
    (latest.commit && latest.commit.message ? latest.commit.message : '').split('\n')[0],
    latestAt ? latestAt.replace('T', ' ').slice(0, 19) : null,
    nowStr,
    repo.id
  );
  return { newCommits: newOnes.length };
}

async function checkCommits() {
  const repos = db.prepare('SELECT * FROM repos').all();
  for (const repo of repos) {
    try {
      await checkRepoCommits(repo);
    } catch (err) {
      const code = err.response ? err.response.status : 'network';
      console.error(`Commit check failed for ${repo.owner}/${repo.name} (${code}):`, err.message);
      db.prepare('UPDATE repos SET status = ?, last_checked_at = ? WHERE id = ?').run(
        `error (${code})`,
        fmtDT(new Date()),
        repo.id
      );
    }
  }
}

async function sendReminders() {
  // manual "send now" — fires every pending task immediately, still respects quiet hours
  const pending = db.prepare('SELECT * FROM tasks WHERE completed = 0 ORDER BY id').all();
  if (pending.length === 0) return { sent: 0 };
  const now = new Date();
  if (inQuietHours(now)) return { sent: 0, quiet: true };
  let sent = 0;
  for (const t of pending) {
    const ok = await sendTelegramMessage(`🔔 <b>Pending: ${t.title}</b>\n[${t.category}]`);
    if (ok) sent++;
  }
  if (sent) logEvent('reminder', `Manual reminder dispatch (${sent} tasks)`);
  return { sent };
}

function startCron() {
  // per-task reminder sweep every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    sendDueReminders().catch((e) => console.error(e));
  });

  // GitHub commit watcher every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    checkCommits().catch((e) => console.error(e));
  });

  setTimeout(() => checkCommits().catch((e) => console.error(e)), 30 * 1000);

  console.log('[cron] schedulers started (task reminders every 5 min, commits every 15 min)');
}

module.exports = {
  startCron,
  sendTelegramMessage,
  checkCommits,
  checkRepoCommits,
  sendDueReminders,
  sendReminders,
  getSetting,
  getIntSetting,
  inQuietHours,
};
