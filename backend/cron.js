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

async function checkCommits() {
  const repos = db.prepare('SELECT * FROM repos').all();
  for (const repo of repos) {
    try {
      const res = await axios.get(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/commits?per_page=5`,
        { headers: githubHeaders(), timeout: 15000 }
      );
      const commits = res.data;
      if (!Array.isArray(commits) || commits.length === 0) continue;

      const newOnes = [];
      for (const c of commits) {
        if (c.sha === repo.last_commit_sha) break; // everything above is new, older ones seen
        newOnes.push(c);
      }
      // iterate oldest-first so messages read chronologically
      for (const c of newOnes.reverse()) {
        const short = c.sha.slice(0, 7);
        const msg = (c.commit && c.commit.message ? c.commit.message : '').split('\n')[0];
        const author = (c.commit && c.commit.author && c.commit.author.name) || 'unknown';
        const text = `🚀 <b>New commit in ${repo.owner}/${repo.name}</b>\n\n<code>${short}</code> — ${msg}\nby ${author}`;
        await sendTelegramMessage(text);
        logEvent('commit', `${short} [${repo.owner}/${repo.name}] ${msg}`);
      }
      if (newOnes.length > 0) {
        db.prepare('UPDATE repos SET last_commit_sha = ? WHERE id = ?').run(commits[0].sha, repo.id);
      }
    } catch (err) {
      const code = err.response ? err.response.status : 'network';
      console.error(`Commit check failed for ${repo.owner}/${repo.name} (${code}):`, err.message);
    }
  }
}

async function sendReminders() {
  const pending = db.prepare("SELECT title, category FROM tasks WHERE completed = 0 ORDER BY id").all();
  if (pending.length === 0) return;
  const lines = pending.map((t) => `• [${t.category}] ${t.title}`).join('\n');
  const sent = await sendTelegramMessage(`🔔 <b>Pending tasks reminder</b> (${pending.length})\n\n${lines}`);
  if (sent) logEvent('reminder', `Sent pending-tasks reminder (${pending.length} tasks)`);
}

function startCron() {
  // Pending-task reminders, every hour on the hour
  cron.schedule('0 * * * *', () => {
    console.log('[cron] hourly reminder tick');
    sendReminders().catch((e) => console.error(e));
  });

  // GitHub commit watcher, every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    console.log('[cron] github commit tick');
    checkCommits().catch((e) => console.error(e));
  });

  // Run a commit check shortly after boot so the feed populates fast
  setTimeout(() => checkCommits().catch((e) => console.error(e)), 30 * 1000);

  console.log('[cron] schedulers started (reminders hourly, commits every 15 min)');
}

module.exports = { startCron, sendTelegramMessage, checkCommits, sendReminders };
