import { useState, useEffect, useCallback } from 'react';
import {
  LayoutDashboard, GitBranch, CheckSquare, Settings as SettingsIcon,
  Plus, Trash2, Bell, Volume2, Send, RefreshCw, Terminal, CheckCircle2,
} from 'lucide-react';

const api = {
  _token: (typeof localStorage !== 'undefined' && localStorage.getItem('dcc_daemon_token')) || '',
  setToken(t) {
    this._token = t;
    try { localStorage.setItem('dcc_daemon_token', t); } catch (e) { /* ignore */ }
  },
  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this._token) h['X-Daemon-Token'] = this._token;
    return h;
  },
  get: (p) => fetch(`/api${p}`, { headers: api.headers() }).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); }),
  post: (p, body) => fetch(`/api${p}`, { method: 'POST', headers: api.headers(), body: JSON.stringify(body || {}) }).then((r) => r.json()),
  put: (p, body) => fetch(`/api${p}`, { method: 'PUT', headers: api.headers(), body: JSON.stringify(body) }).then((r) => r.json()),
  patch: (p, body) => fetch(`/api${p}`, { method: 'PATCH', headers: api.headers(), body: JSON.stringify(body) }).then((r) => r.json()),
  del: (p) => fetch(`/api${p}`, { method: 'DELETE', headers: api.headers() }).then((r) => r.json()),
};

function Card({ title, icon, children, glow }) {
  return (
    <div className={`glass rounded-xl p-5 transition-all ${glow ? 'card-glow' : ''}`}>
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h2 className="text-sm uppercase tracking-widest text-gray-300">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Nav({ tab, setTab }) {
  const items = [
    { id: 'dashboard', label: 'Overview', icon: <LayoutDashboard size={16} /> },
    { id: 'github', label: 'GitHub Watcher', icon: <GitBranch size={16} /> },
    { id: 'tasks', label: 'Projects & Plans', icon: <CheckSquare size={16} /> },
    { id: 'settings', label: 'Telegram & Daemon', icon: <SettingsIcon size={16} /> },
  ];
  return (
    <nav className="flex flex-wrap gap-2 mb-8">
      {items.map((i) => (
        <button
          key={i.id}
          onClick={() => setTab(i.id)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm border transition-all ${
            tab === i.id
              ? 'border-neon text-neon neon-text'
              : 'border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-700'
          }`}
        >
          {i.icon} {i.label}
        </button>
      ))}
    </nav>
  );
}

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [tasks, setTasks] = useState([]);
  const [repos, setRepos] = useState([]);
  const [events, setEvents] = useState([]);
  const [health, setHealth] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [t, r, e, h] = await Promise.all([
        api.get('/tasks'), api.get('/repos'), api.get('/events'), api.get('/health'),
      ]);
      setTasks(t); setRepos(r); setEvents(e); setHealth(h);
    } catch (err) {
      console.error('refresh failed:', err);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, [refresh]);

  const pending = tasks.filter((t) => !t.completed);
  const projectTasks = tasks.filter((t) => t.category === 'project');
  const planTasks = tasks.filter((t) => t.category === 'plan');

  return (
    <div className="min-h-screen bg-void p-4 md:p-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold neon-text">COMMAND // CENTER</h1>
          <p className="text-xs text-gray-500 mt-1 tracking-wider">
            MULTI-PROJECT FOCUS ENGINE &amp; DAEMON BRIDGE
            {health && <span className="text-mint ml-2">● backend online</span>}
          </p>
        </div>
        <button onClick={refresh} className="flex items-center gap-2 text-gray-400 hover:text-neon text-sm">
          <RefreshCw size={14} /> refresh
        </button>
      </header>

      <Nav tab={tab} setTab={setTab} />

      {tab === 'dashboard' && (
        <div className="grid md:grid-cols-3 gap-4">
          <Card title="Pending Tasks" icon={<CheckSquare size={16} className="text-neon" />} glow>
            <p className="text-4xl font-bold text-white">{pending.length}</p>
            <p className="text-xs text-gray-500 mt-1">across {projectTasks.length} project + {planTasks.length} plan items</p>
            <button onClick={() => setTab('tasks')} className="mt-4 text-neon text-sm hover:underline">manage →</button>
          </Card>
          <Card title="Watched Repos" icon={<GitBranch size={16} className="text-violet2" />} glow>
            <p className="text-4xl font-bold text-white">{repos.length}</p>
            <p className="text-xs text-gray-500 mt-1">commit check every 15 min</p>
            <button onClick={() => setTab('github')} className="mt-4 text-violet2 text-sm hover:underline">manage →</button>
          </Card>
          <Card title="Alarm Daemon" icon={<Volume2 size={16} className="text-mint" />} glow>
            <p className="text-sm text-gray-300 mt-2">PC daemon polls <span className="text-neon">/api/daemon/check-alarm</span> for a real hardware beep.</p>
            <button
              onClick={() => api.post('/daemon/trigger-alarm').then(refresh)}
              className="mt-4 px-4 py-2 rounded-lg bg-neon text-black text-sm font-bold hover:opacity-90"
            >
              🚨 Ring my PC now
            </button>
          </Card>
          <div className="md:col-span-3">
            <Card title="Activity Feed" icon={<Terminal size={16} className="text-neon" />}>
              {events.length === 0 && <p className="text-sm text-gray-500">No activity yet. Add a repo or send a test ping.</p>}
              <ul className="space-y-2 max-h-72 overflow-y-auto">
                {events.map((e) => (
                  <li key={e.id} className="text-sm border-l-2 border-neon/40 pl-3 py-1">
                    <span className="text-gray-500 text-xs mr-2">[{e.type}]</span>
                    <span className="text-gray-300">{e.message}</span>
                    <span className="text-gray-600 text-xs ml-2">{e.created_at}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}

      {tab === 'github' && <GithubPanel repos={repos} refresh={refresh} />}
      {tab === 'tasks' && <TasksPanel tasks={tasks} refresh={refresh} />}
      {tab === 'settings' && <SettingsPanel refresh={refresh} />}
    </div>
  );
}

function GithubPanel({ repos, refresh }) {
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [checking, setChecking] = useState(false);

  const add = async () => {
    if (!owner.trim() || !name.trim()) return;
    const res = await api.post('/repos', { owner, name });
    if (res.error) return alert(res.error);
    setOwner(''); setName('');
    refresh();
  };

  const checkNow = async () => {
    setChecking(true);
    await api.post('/repos/check-now');
    setChecking(false);
    refresh();
  };

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card title="Add Repo Connector" icon={<Plus size={16} className="text-neon" />}>
        <div className="flex flex-col gap-3">
          <input placeholder="owner (e.g. United-DG)" value={owner} onChange={(e) => setOwner(e.target.value)} />
          <input placeholder="repo name (e.g. IMS)" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={add} className="px-4 py-2 rounded-lg bg-neon text-black text-sm font-bold hover:opacity-90">+ Connect repo</button>
          <button onClick={checkNow} disabled={checking} className="flex items-center gap-2 text-sm text-gray-400 hover:text-neon">
            <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
            {checking ? 'checking…' : 'check commits now'}
          </button>
        </div>
      </Card>
      <Card title={`Watching (${repos.length})`} icon={<GitBranch size={16} className="text-violet2" />}>
        {repos.length === 0 && <p className="text-sm text-gray-500">No repos yet — connect one above.</p>}
        <ul className="space-y-2">
          {repos.map((r) => (
            <li key={r.id} className="flex items-center justify-between text-sm border border-white/5 rounded-lg px-3 py-2">
              <span className="text-gray-200">{r.owner}/{r.name}</span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-gray-500">{r.last_commit_sha ? r.last_commit_sha.slice(0, 7) : 'no commits seen'}</span>
                <button onClick={() => api.del(`/repos/${r.id}`).then(refresh)} className="text-gray-500 hover:text-red-400">
                  <Trash2 size={14} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function TasksPanel({ tasks, refresh }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('project');

  const add = async () => {
    if (!title.trim()) return;
    await api.post('/tasks', { title, category });
    setTitle('');
    refresh();
  };

  const toggle = (t) => api.patch(`/tasks/${t.id}`, { completed: !t.completed }).then(refresh);
  const remove = (t) => api.del(`/tasks/${t.id}`).then(refresh);

  const list = (cat, label) => (
    <Card title={label} icon={<CheckSquare size={16} className="text-neon" />}>
      <ul className="space-y-2">
        {tasks.filter((t) => t.category === cat).map((t) => (
          <li key={t.id} className={`flex items-center gap-3 text-sm rounded-lg px-3 py-2 border ${t.completed ? 'border-mint/30 opacity-60' : 'border-white/5'}`}>
            <button onClick={() => toggle(t)} className={t.completed ? 'text-mint' : 'text-gray-500 hover:text-neon'}>
              <CheckCircle2 size={16} />
            </button>
            <span className={`flex-1 ${t.completed ? 'line-through text-gray-500' : 'text-gray-200'}`}>{t.title}</span>
            <button onClick={() => remove(t)} className="text-gray-600 hover:text-red-400"><Trash2 size={14} /></button>
          </li>
        ))}
        {tasks.filter((t) => t.category === cat).length === 0 && (
          <p className="text-sm text-gray-500">Nothing here yet.</p>
        )}
      </ul>
    </Card>
  );

  return (
    <div className="space-y-4">
      <Card title="Add Item" icon={<Plus size={16} className="text-neon" />}>
        <div className="flex flex-col md:flex-row gap-3">
          <input className="flex-1" placeholder="e.g. wire M-Pesa callback into billing" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="project">project</option>
            <option value="plan">plan</option>
          </select>
          <button onClick={add} className="px-4 py-2 rounded-lg bg-neon text-black text-sm font-bold hover:opacity-90">+ Add</button>
        </div>
      </Card>
      <div className="grid md:grid-cols-2 gap-4">
        {list('project', 'Active Projects')}
        {list('plan', 'Future Plans')}
      </div>
    </div>
  );
}

function SettingsPanel({ refresh }) {
  const [cfg, setCfg] = useState({ tg_bot_token: '', tg_chat_id: '', github_token: '' });
  const [status, setStatus] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [daemonToken, setDaemonToken] = useState(
    (typeof localStorage !== 'undefined' && localStorage.getItem('dcc_daemon_token')) || ''
  );

  useEffect(() => {
    api.get('/settings').then((s) => {
      setCfg({
        tg_bot_token: s.tg_bot_token === '***set***' ? '' : (s.tg_bot_token || ''),
        tg_chat_id: s.tg_chat_id || '',
        github_token: s.github_token === '***set***' ? '' : (s.github_token || ''),
      });
    }).catch(() => {});
  }, []);

  const save = async () => {
    const body = {};
    if (cfg.tg_bot_token) body.tg_bot_token = cfg.tg_bot_token;
    if (cfg.tg_chat_id) body.tg_chat_id = cfg.tg_chat_id;
    if (cfg.github_token) body.github_token = cfg.github_token;
    const res = await api.put('/settings', body);
    setStatus(res.success ? 'saved ✓' : 'save failed');
    setTimeout(() => setStatus(''), 3000);
    refresh();
  };

  const testPing = async () => {
    const res = await api.post('/telegram/test', { message: testMsg || undefined });
    setStatus(res.success ? 'ping sent ✓ check Telegram' : `failed: ${res.error}`);
    setTimeout(() => setStatus(''), 4000);
    refresh();
  };

  const ringPc = () => api.post('/daemon/trigger-alarm').then((r) => {
    setStatus(r && r.success ? 'alarm signal queued — daemon will beep within ~10s' : `trigger failed: ${(r && r.error) || 'check daemon token'}`);
    setTimeout(() => setStatus(''), 4000);
    refresh();
  });

  const sendReminderNow = () => api.post('/reminders/send-now').then((r) => {
    setStatus(r && (r.success !== false) ? 'reminder dispatch queued' : `failed: ${(r && r.error) || 'check daemon token'}`);
    setTimeout(() => setStatus(''), 4000);
    refresh();
  });

  const saveDaemonToken = () => {
    api.setToken(daemonToken.trim());
    setStatus('daemon token saved in this browser ✓');
    setTimeout(() => setStatus(''), 3000);
  };

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card title="Telegram Bot" icon={<Send size={16} className="text-neon" />}>
        <div className="flex flex-col gap-3">
          <input type="password" placeholder="Bot token (from @BotFather)" value={cfg.tg_bot_token} onChange={(e) => setCfg({ ...cfg, tg_bot_token: e.target.value })} />
          <input placeholder="Chat ID" value={cfg.tg_chat_id} onChange={(e) => setCfg({ ...cfg, tg_chat_id: e.target.value })} />
          <input type="password" placeholder="GitHub token (optional, raises API rate limit)" value={cfg.github_token} onChange={(e) => setCfg({ ...cfg, github_token: e.target.value })} />
          <button onClick={save} className="px-4 py-2 rounded-lg bg-neon text-black text-sm font-bold hover:opacity-90">Save settings</button>
        </div>
      </Card>
      <Card title="Test Triggers" icon={<Bell size={16} className="text-violet2" />}>
        <div className="flex flex-col gap-3">
          <input type="password" placeholder="Daemon token (must match server DAEMON_TOKEN)" value={daemonToken} onChange={(e) => setDaemonToken(e.target.value)} />
          <button onClick={saveDaemonToken} className="px-4 py-2 rounded-lg bg-violet2 text-black text-sm font-bold hover:opacity-90">Save daemon token</button>
          <input placeholder="Custom test message (optional)" value={testMsg} onChange={(e) => setTestMsg(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button onClick={testPing} className="px-4 py-2 rounded-lg border border-neon text-neon text-sm hover:bg-neon/10">📲 Test Telegram ping</button>
            <button onClick={ringPc} className="px-4 py-2 rounded-lg border border-mint text-mint text-sm hover:bg-mint/10">🚨 Ring PC alarm</button>
            <button onClick={sendReminderNow} className="px-4 py-2 rounded-lg border border-violet2 text-violet2 text-sm hover:bg-violet2/10">🔔 Send reminders now</button>
          </div>
          {status && <p className="text-sm text-gray-400">{status}</p>}
        </div>
      </Card>
      <div className="md:col-span-2">
        <Card title="PC Daemon Setup" icon={<Volume2 size={16} className="text-mint" />}>
          <p className="text-sm text-gray-400 leading-relaxed">
            On your Windows machine, run the daemon in <span className="text-neon">pc-daemon/</span> — it polls the backend every 10s and plays a real
            hardware beep whenever an alarm is queued. Point <span className="text-neon">SERVER_URL</span> at your 24/7 server, then run
            <code className="text-gray-200"> python alarm_daemon.py</code>. Add it to Windows Task Scheduler to start on boot (see README).
          </p>
        </Card>
      </div>
    </div>
  );
}
