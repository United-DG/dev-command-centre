# Developer Command Center

A self-hosted multi-project tracker for people who code on several things at once
and refuse to manually log progress. It watches your GitHub repos, keeps project
+ plan checklists, pings you on Telegram, and rings a real PC beep when it wants
your attention — all from a single web dashboard.

```
dev-command-center/
├── docker-compose.yml      # one-command server deployment
├── .env.example            # config template
├── backend/                # Express API + SQLite + cron (Telegram, GitHub watcher)
├── frontend/               # React + Vite + Tailwind dashboard (served by nginx)
└── pc-daemon/              # Python script: real hardware beep on your Windows PC
```

## What it does

- **GitHub connectors** — add `owner/repo` pairs; the backend checks for new commits
  every 15 minutes and fires a Telegram message per commit. Zero manual input.
- **Project & plan checklists** — two boards on the dashboard, mark done with one
  click, hourly Telegram reminder of everything still pending.
- **PC alarm** — a tiny Python daemon on your machine polls the server and plays a
  real beep via `winsound` when an alarm is queued (or hourly reminders come in).
- **SQLite persistence** — one file, no cloud, no accounts, survives restarts.

## Deploy on your 24/7 server (Docker)

```bash
git clone <this-repo> dev-command-center
cd dev-command-center

cp .env.example .env
# edit .env: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (from @BotFather)

docker compose up -d --build
```

- Dashboard: `http://YOUR_SERVER_IP`
- API: `http://YOUR_SERVER_IP:5000/api/health`

The SQLite database lives in a named Docker volume, so data survives rebuilds.

### Deploy without Docker

```bash
cd backend
npm install
cp ../.env.example ../.env   # or export env vars directly
node server.js               # keep alive with pm2: pm2 start server.js --name dcc
```
Then build the frontend (`cd frontend && npm install && npm run build`) and serve
`dist/` with nginx, proxying `/api/` to `http://localhost:5000/api/` (config in
`frontend/nginx.conf`).

## PC audio daemon (Windows)

```bash
cd pc-daemon
pip install -r requirements.txt
python alarm_daemon.py --server http://YOUR_SERVER_IP:5000
```

Options (also via env vars `DCC_SERVER`, `DCC_INTERVAL`, `DCC_TOKEN`):
`--server`, `--interval` (poll seconds, default 10), `--token` (if `DAEMON_TOKEN` is set).

**Start on boot:** open Windows Task Scheduler → Create Task → trigger "At log on" →
action "Start a program": `pythonw.exe` with argument
`C:\path\to\pc-daemon\alarm_daemon.py --server http://YOUR_SERVER_IP:5000`
→ condition: start only if network available. `pythonw` runs it without a console window.

On WSL/Linux the daemon falls back to a terminal bell; on macOS it uses `afplay`.

## Telegram setup

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Message your new bot once (say hi), then get your chat id:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` → `message.chat.id`.
3. Put both in `.env` (or in the dashboard: *Telegram & Daemon* tab → Save settings).
4. Hit **Test Telegram ping** in the dashboard.

Schedules: pending-task reminders **every hour on the hour**, commit checks
**every 15 minutes**. To fire them manually: *Test Triggers → Send reminders now*
and *GitHub Watcher → check commits now*.

## API reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | backend liveness |
| GET/POST | `/api/tasks` | list / create (category: `project`/`plan`) |
| PATCH/DELETE | `/api/tasks/:id` | toggle done / delete |
| GET/POST | `/api/repos` | list / watch a repo (`owner`, `name`) |
| DELETE | `/api/repos/:id` | stop watching |
| POST | `/api/repos/check-now` | run the commit check immediately |
| GET | `/api/events` | activity feed (commits, reminders, alarms) |
| GET/PUT | `/api/settings` | bot token, chat id, GitHub token |
| POST | `/api/telegram/test` | send a test message |
| GET | `/api/daemon/check-alarm` | daemon poll: `{ sound_alarm }` (consumed) |
| POST | `/api/daemon/trigger-alarm` | ring the PC now |
| POST | `/api/reminders/send-now` | fire the hourly reminder immediately |

If `DAEMON_TOKEN` is set, mutating endpoints and settings require it via
`?token=` or the `X-Daemon-Token` header.

## Future hooks

The dashboard has a *Future Plans* board for a reason — natural next connectors:
IMAP/email webhook parser, VS Code save-event webhook, calendar deadlines. The
backend is one small `cron.js` + REST file, so new sources plug in cleanly.
