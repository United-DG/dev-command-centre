const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- base schema (fresh installs) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    last_commit_sha TEXT,
    last_commit_msg TEXT,
    last_commit_at DATETIME,
    status TEXT DEFAULT 'ok',
    last_checked_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(owner, name)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT CHECK(category IN ('project', 'plan')) NOT NULL DEFAULT 'project',
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    due_at DATETIME,
    reminder_minutes INTEGER,
    next_reminder_at DATETIME,
    project_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ---------- lightweight migrations for existing installs ----------
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`[db] migrated: ${table}.${column} added`);
  }
}

ensureColumn('repos', 'last_commit_msg', 'TEXT');
ensureColumn('repos', 'last_commit_at', 'DATETIME');
ensureColumn('repos', 'status', "TEXT DEFAULT 'ok'");
ensureColumn('repos', 'last_checked_at', 'DATETIME');
ensureColumn('tasks', 'due_at', 'DATETIME');
ensureColumn('tasks', 'reminder_minutes', 'INTEGER');
ensureColumn('tasks', 'next_reminder_at', 'DATETIME');
ensureColumn('tasks', 'project_id', 'INTEGER REFERENCES tasks(id) ON DELETE CASCADE');
ensureColumn('tasks', 'repo_id', 'INTEGER REFERENCES repos(id) ON DELETE CASCADE');

// NOTE: SQLite cannot add a FOREIGN KEY via ALTER TABLE ADD COLUMN with
// enforcement on pre-existing tables in all cases, so cascade deletes are
// ALSO enforced manually in the DELETE endpoints below (belt and suspenders).

const MAX_EVENTS = 200;
db.prepare(
  `DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)`
).run(MAX_EVENTS);

// ---------- boot-time backup ----------
// Cheap insurance for a 24/7 box that gets rebuilt often: snapshot data.db
// on every boot, keep the newest 10. Restoring = copy a backup over data.db
// while the backend is stopped.
try {
  const dbPath = path.join(dataDir, 'data.db');
  if (fs.existsSync(dbPath)) {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
    const backupDir = path.join(dataDir, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(backupDir, `data-${stamp}.db`);
    fs.copyFileSync(dbPath, dest);
    console.log(`[db] boot backup -> ${dest}`);
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith('data-') && f.endsWith('.db'))
      .sort();
    while (files.length > 10) {
      fs.unlinkSync(path.join(backupDir, files.shift()));
    }
  }
} catch (e) {
  console.error('[db] boot backup failed:', e.message);
}

function logEvent(type, message) {
  try {
    db.prepare('INSERT INTO events (type, message) VALUES (?, ?)').run(type, message);
  } catch (e) {
    console.error('logEvent failed:', e.message);
  }
}

module.exports = { db, logEvent };
