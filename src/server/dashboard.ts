/**
 * dashboard.ts — self-contained ops dashboard HTML renderer.
 *
 * Returns a single HTML string with inlined CSS + vanilla JS.
 * The JS calls /admin/state, /admin/control, /admin/memory, and /session/:id
 * using the password stored in sessionStorage (user enters it once on load).
 *
 * No external CDN resources — fully offline-capable.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildDashboardHtml(agentName: string): string {
  const name = esc(agentName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${name} · ops</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
  background:#0d1117;color:#c9d1d9;min-height:100vh}
a{color:#58a6ff;text-decoration:none}
button{cursor:pointer;font:inherit;border:1px solid #30363d;border-radius:6px;
  padding:4px 10px;background:#21262d;color:#c9d1d9;transition:background .15s}
button:hover{background:#30363d}
button.danger{border-color:#f8514977;color:#f85149}
button.danger:hover{background:#f8514922}
button.primary{border-color:#388bfd77;color:#58a6ff}
button.primary:hover{background:#388bfd22}
input,select{font:inherit;background:#0d1117;border:1px solid #30363d;
  border-radius:6px;color:#c9d1d9;padding:4px 8px}
input:focus,select:focus{outline:none;border-color:#58a6ff}
input::placeholder{color:#484f58}

/* layout */
#overlay{position:fixed;inset:0;background:#0d1117;z-index:100;
  display:flex;align-items:center;justify-content:center}
.login-box{border:1px solid #30363d;border-radius:12px;padding:32px;
  width:320px;text-align:center;background:#161b22}
.login-box h2{margin-bottom:16px;color:#e6edf3;font-size:16px}
.login-box input{width:100%;margin-bottom:12px;padding:8px 10px}
.login-box button{width:100%;padding:8px;font-size:13px}
.login-box .err{color:#f85149;font-size:12px;margin-top:8px;min-height:16px}

header{border-bottom:1px solid #21262d;padding:10px 20px;
  display:flex;align-items:center;gap:12px;background:#161b22}
header h1{font-size:14px;color:#e6edf3;flex:1}
#status-dot{width:8px;height:8px;border-radius:50%;background:#3fb950;
  flex-shrink:0}
#status-dot.warn{background:#d29922}
#status-dot.err{background:#f85149}
#header-meta{color:#484f58;font-size:12px}
#last-refresh{color:#484f58;font-size:11px}

main{padding:16px;display:grid;
  grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}
.panel{border:1px solid #21262d;border-radius:8px;background:#161b22;
  overflow:hidden}
.panel-header{padding:10px 14px;border-bottom:1px solid #21262d;
  font-size:12px;color:#8b949e;font-weight:600;letter-spacing:.05em;
  text-transform:uppercase;display:flex;align-items:center;gap:8px}
.panel-header .badge{font-size:10px;background:#21262d;border-radius:10px;
  padding:1px 6px;color:#58a6ff;font-weight:normal;text-transform:none}
.panel-body{padding:12px 14px}

/* agent panel */
#caps-list{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
#caps-list li{background:#21262d;border-radius:4px;padding:2px 8px;
  font-size:12px;color:#e6edf3}
.kv{display:flex;gap:8px;margin-bottom:4px;font-size:12px}
.kv .k{color:#484f58;min-width:90px}
.kv .v{color:#e6edf3}

/* control panel */
.ctrl-section{margin-bottom:14px;padding-bottom:14px;
  border-bottom:1px solid #21262d}
.ctrl-section:last-of-type{border-bottom:none;margin-bottom:0;padding-bottom:0}
.ctrl-section label{display:block;font-size:11px;color:#8b949e;
  margin-bottom:6px;font-weight:600}
.ctrl-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ctrl-row input{flex:1;min-width:80px}
.ctrl-state{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}
.tag{background:#21262d;border-radius:4px;padding:2px 8px;
  font-size:11px;display:flex;align-items:center;gap:4px}
.tag.killed{color:#f85149;border:1px solid #f8514944}
.tag.paused{color:#d29922;border:1px solid #d2992244}
.tag.disabled{color:#8b949e;border:1px solid #30363d}
.tag .x{cursor:pointer;opacity:.6;font-size:10px;padding:0 2px}
.tag .x:hover{opacity:1}
.ctrl-msg{font-size:11px;margin-top:6px;padding:4px 8px;border-radius:4px;
  display:none}
.ctrl-msg.ok{background:#3fb95022;color:#3fb950;display:block}
.ctrl-msg.err{background:#f8514922;color:#f85149;display:block}

/* memory panel */
.mem-search-row{display:flex;gap:6px;margin-bottom:10px}
.mem-search-row input{flex:1}
.mem-result{padding:8px;border-radius:6px;border:1px solid #21262d;
  margin-bottom:6px;background:#0d1117}
.mem-result .content{font-size:12px;color:#e6edf3;margin-bottom:4px;
  white-space:pre-wrap;word-break:break-word}
.mem-result .meta{font-size:10px;color:#484f58}
#mem-placeholder{color:#484f58;font-size:12px;padding:8px 0}

/* session panel */
.sess-row{display:flex;gap:6px;margin-bottom:10px}
.sess-row input{flex:1}
.msg{padding:6px 10px;border-radius:6px;margin-bottom:4px;font-size:12px;
  max-width:90%;word-break:break-word;white-space:pre-wrap}
.msg.user{background:#21262d;color:#e6edf3;margin-left:auto;text-align:right}
.msg.assistant{background:#1c2d3a;color:#58a6ff}
.msg.system{background:#1a1f24;color:#484f58;font-style:italic;max-width:100%}
.msg-role{font-size:10px;opacity:.6;margin-bottom:2px}
#task-info{margin-top:10px;font-size:12px;color:#d29922;padding:6px 8px;
  border:1px solid #d2992244;border-radius:6px;background:#d2992211}
#sess-placeholder{color:#484f58;font-size:12px;padding:8px 0}

/* approvals panel */
.approval-card{border:1px solid #d2992244;border-radius:6px;padding:10px;
  margin-bottom:8px;background:#d2992211}
.approval-card .task-id{font-size:11px;color:#d29922;margin-bottom:4px}
.approval-card .question{font-size:12px;color:#e6edf3;margin-bottom:8px}
.approval-card .btns{display:flex;gap:6px}
#approvals-empty{color:#484f58;font-size:12px;padding:8px 0}

.spinner{display:inline-block;width:10px;height:10px;border:1.5px solid #484f58;
  border-top-color:#58a6ff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<!-- ─── Login overlay ───────────────────────────────────── -->
<div id="overlay">
  <div class="login-box">
    <h2>${name}</h2>
    <p style="color:#8b949e;font-size:12px;margin-bottom:16px">Ops Dashboard</p>
    <input type="password" id="pw-input" placeholder="Dashboard password" autocomplete="current-password"/>
    <button class="primary" onclick="submitLogin()">Unlock</button>
    <div class="err" id="login-err"></div>
  </div>
</div>

<!-- ─── App ─────────────────────────────────────────────── -->
<div id="app" style="display:none">

<header>
  <div id="status-dot"></div>
  <h1 id="h-name">${name}</h1>
  <span id="header-meta"></span>
  <span id="last-refresh"></span>
</header>

<main>

<!-- Agent Overview -->
<div class="panel">
  <div class="panel-header">Agent</div>
  <div class="panel-body">
    <div id="agent-kv"></div>
    <div style="margin-top:10px;font-size:11px;color:#8b949e;font-weight:600">CAPABILITIES</div>
    <ul id="caps-list"><li>—</li></ul>
  </div>
</div>

<!-- Pending Approvals -->
<div class="panel">
  <div class="panel-header">
    Pending Approvals
    <span class="badge" id="approval-count">0</span>
  </div>
  <div class="panel-body">
    <div id="approvals-list">
      <div id="approvals-empty">No pending approvals</div>
    </div>
  </div>
</div>

<!-- Control Bus -->
<div class="panel">
  <div class="panel-header">Control Bus</div>
  <div class="panel-body">

    <div class="ctrl-section">
      <label>KILL TASK</label>
      <div class="ctrl-row">
        <input id="kill-task-id" placeholder="task ID"/>
        <input id="kill-task-reason" placeholder="reason"/>
        <button class="danger" onclick="killTask()">Kill</button>
      </div>
      <div class="ctrl-state" id="killed-tags"></div>
    </div>

    <div class="ctrl-section">
      <label>TENANT</label>
      <div class="ctrl-row">
        <input id="tenant-id" placeholder="tenant ID"/>
        <input id="tenant-reason" placeholder="reason"/>
        <button class="danger" onclick="pauseTenant()">Pause</button>
        <button onclick="resumeTenant()">Resume</button>
      </div>
      <div class="ctrl-state" id="paused-tags"></div>
    </div>

    <div class="ctrl-section">
      <label>TOOL</label>
      <div class="ctrl-row">
        <input id="tool-name" placeholder="tool name"/>
        <input id="tool-reason" placeholder="reason"/>
        <button class="danger" onclick="disableTool()">Disable</button>
        <button onclick="enableTool()">Enable</button>
      </div>
      <div class="ctrl-state" id="disabled-tags"></div>
    </div>

    <div class="ctrl-msg" id="ctrl-msg"></div>
  </div>
</div>

<!-- Memory Search -->
<div class="panel">
  <div class="panel-header">Memory Search</div>
  <div class="panel-body">
    <div class="mem-search-row">
      <input id="mem-q" placeholder="search memories…" onkeydown="if(event.key==='Enter')searchMemory()"/>
      <button class="primary" onclick="searchMemory()">Search</button>
    </div>
    <div id="mem-results">
      <div id="mem-placeholder">Enter a query above</div>
    </div>
  </div>
</div>

<!-- Session Inspector -->
<div class="panel">
  <div class="panel-header">Session Inspector</div>
  <div class="panel-body">
    <div class="sess-row">
      <input id="sess-id" placeholder="session ID" onkeydown="if(event.key==='Enter')loadSession()"/>
      <button class="primary" onclick="loadSession()">Load</button>
    </div>
    <div id="sess-messages">
      <div id="sess-placeholder">Enter a session ID above</div>
    </div>
    <div id="task-info" style="display:none"></div>
  </div>
</div>

</main>
</div>

<script>
/* ── state ───────────────────────────────────────────────── */
const S = {
  password: sessionStorage.getItem('msm_pw') || '',
  controlState: { killedTasks: [], pausedTenants: [], disabledTools: [] },
};

/* ── auth ────────────────────────────────────────────────── */
function authHeader() {
  return { Authorization: 'Basic ' + btoa(':' + S.password) };
}

async function api(path, opts) {
  opts = opts || {};
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeader(), ...(opts.headers || {}) },
  });
  if (res.status === 401) { showOverlay('Wrong password'); return null; }
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(txt);
  }
  return res.json();
}

/* ── login ───────────────────────────────────────────────── */
function showOverlay(err) {
  document.getElementById('overlay').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  if (err) document.getElementById('login-err').textContent = err;
  sessionStorage.removeItem('msm_pw');
  S.password = '';
}

async function submitLogin() {
  const pw = document.getElementById('pw-input').value;
  if (!pw) return;
  S.password = pw;
  const data = await api('/admin/state').catch(() => null);
  if (data === null) return; // 401 already handled
  sessionStorage.setItem('msm_pw', pw);
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  renderState(data);
  startPolling();
}

document.getElementById('pw-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') submitLogin();
});

/* ── polling ─────────────────────────────────────────────── */
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(refreshState, 5000);
  refreshState();
}

async function refreshState() {
  const data = await api('/admin/state').catch(() => null);
  if (!data) return;
  renderState(data);
  document.getElementById('last-refresh').textContent =
    'refreshed ' + new Date().toLocaleTimeString();
}

/* ── render: overview ────────────────────────────────────── */
function renderState(data) {
  const h = data.health || {};
  const dot = document.getElementById('status-dot');
  dot.className = h.ready ? '' : 'warn';
  document.getElementById('h-name').textContent = h.name || '${name}';
  document.getElementById('header-meta').textContent =
    [h.brain, h.provider].filter(Boolean).join(' · ');

  const kv = document.getElementById('agent-kv');
  kv.innerHTML = [
    ['name', h.name], ['brain', h.brain], ['provider', h.provider],
    ['version', h.version], ['status', h.ready ? '● ready' : '○ not ready'],
  ].map(([k,v]) => v != null
    ? '<div class="kv"><span class="k">'+k+'</span><span class="v">'+esc(String(v))+'</span></div>'
    : '').join('');

  const caps = document.getElementById('caps-list');
  const list = h.capabilities || [];
  caps.innerHTML = list.length
    ? list.map(c => '<li>'+esc(c)+'</li>').join('')
    : '<li style="color:#484f58">—</li>';

  S.controlState = data.controlState || S.controlState;
  renderControlState();
  renderApprovals(data.pendingApprovals || []);
}

/* ── render: control state ───────────────────────────────── */
function renderControlState() {
  const cs = S.controlState;
  const killed = document.getElementById('killed-tags');
  const paused = document.getElementById('paused-tags');
  const disabled = document.getElementById('disabled-tags');

  killed.innerHTML = (cs.killedTasks || []).map(id =>
    '<span class="tag killed">⊗ '+esc(id)+'</span>').join('') || '';
  paused.innerHTML = (cs.pausedTenants || []).map(id =>
    '<span class="tag paused" data-tid="'+esc(id)+'">⏸ '+esc(id)+
    ' <span class="x" onclick="resumeTenantTag(\''+esc(id)+'\')">✕</span></span>').join('') || '';
  disabled.innerHTML = (cs.disabledTools || []).map(n =>
    '<span class="tag disabled" data-tool="'+esc(n)+'">⊘ '+esc(n)+
    ' <span class="x" onclick="enableToolTag(\''+esc(n)+'\')">✕</span></span>').join('') || '';
}

/* ── render: approvals ───────────────────────────────────── */
function renderApprovals(list) {
  const el = document.getElementById('approvals-list');
  document.getElementById('approval-count').textContent = list.length;
  if (!list.length) {
    el.innerHTML = '<div id="approvals-empty">No pending approvals</div>';
    return;
  }
  el.innerHTML = list.map(t =>
    '<div class="approval-card">'+
    '<div class="task-id">task: '+esc(t.taskId||t.id||'?')+'  ·  session: '+esc(t.sessionId||'?')+'</div>'+
    '<div class="question">'+esc(t.question||t.description||JSON.stringify(t))+'</div>'+
    '<div class="btns">'+
    '<button class="primary" onclick="approve(\''+esc(t.sessionId)+'\',\''+esc(t.taskId||t.id)+'\',true)">Approve</button>'+
    '<button class="danger" onclick="approve(\''+esc(t.sessionId)+'\',\''+esc(t.taskId||t.id)+'\',false)">Deny</button>'+
    '</div></div>'
  ).join('');
}

/* ── control bus actions ─────────────────────────────────── */
function ctrlMsg(msg, isErr) {
  const el = document.getElementById('ctrl-msg');
  el.className = 'ctrl-msg ' + (isErr ? 'err' : 'ok');
  el.textContent = msg;
  setTimeout(() => { el.style.display = 'none'; el.className = 'ctrl-msg'; }, 3000);
}

async function postControl(cmd) {
  const data = await api('/admin/control', { method: 'POST', body: JSON.stringify(cmd) })
    .catch(e => { ctrlMsg(e.message, true); return null; });
  if (!data) return false;
  S.controlState = data.controlState;
  renderControlState();
  ctrlMsg('Done: ' + cmd.type, false);
  return true;
}

async function killTask() {
  const id = document.getElementById('kill-task-id').value.trim();
  const reason = document.getElementById('kill-task-reason').value.trim() || 'killed via dashboard';
  if (!id) { ctrlMsg('Task ID required', true); return; }
  if (await postControl({ type: 'kill_task', taskId: id, reason })) {
    document.getElementById('kill-task-id').value = '';
  }
}

async function pauseTenant() {
  const id = document.getElementById('tenant-id').value.trim();
  const reason = document.getElementById('tenant-reason').value.trim() || 'paused via dashboard';
  if (!id) { ctrlMsg('Tenant ID required', true); return; }
  await postControl({ type: 'pause_tenant', tenantId: id, reason });
}

async function resumeTenant() {
  const id = document.getElementById('tenant-id').value.trim();
  if (!id) { ctrlMsg('Tenant ID required', true); return; }
  await postControl({ type: 'resume_tenant', tenantId: id });
}

async function resumeTenantTag(id) {
  await postControl({ type: 'resume_tenant', tenantId: id });
}

async function disableTool() {
  const name = document.getElementById('tool-name').value.trim();
  const reason = document.getElementById('tool-reason').value.trim() || 'disabled via dashboard';
  if (!name) { ctrlMsg('Tool name required', true); return; }
  await postControl({ type: 'disable_tool', toolName: name, reason });
}

async function enableTool() {
  const name = document.getElementById('tool-name').value.trim();
  if (!name) { ctrlMsg('Tool name required', true); return; }
  await postControl({ type: 'enable_tool', toolName: name });
}

async function enableToolTag(name) {
  await postControl({ type: 'enable_tool', toolName: name });
}

/* ── approvals ───────────────────────────────────────────── */
async function approve(sessionId, taskId, approved) {
  const data = await api('/task/approve', {
    method: 'POST',
    body: JSON.stringify({ sessionId, taskId, approved, decidedBy: 'dashboard' }),
  }).catch(e => { alert(e.message); return null; });
  if (data) refreshState();
}

/* ── memory search ───────────────────────────────────────── */
async function searchMemory() {
  const q = document.getElementById('mem-q').value.trim();
  if (!q) return;
  const el = document.getElementById('mem-results');
  el.innerHTML = '<span class="spinner"></span>';
  const data = await api('/admin/memory?q=' + encodeURIComponent(q) + '&limit=10')
    .catch(e => { el.innerHTML = '<div style="color:#f85149">'+esc(e.message)+'</div>'; return null; });
  if (!data) return;
  const entries = data.entries || [];
  if (!entries.length) {
    el.innerHTML = '<div id="mem-placeholder">No results</div>';
    return;
  }
  el.innerHTML = entries.map(e =>
    '<div class="mem-result">'+
    '<div class="content">'+esc(e.content || e.text || JSON.stringify(e))+'</div>'+
    '<div class="meta">'+esc(e.sessionId||'')+(e.timestamp?' · '+new Date(e.timestamp).toLocaleString():'')+'</div>'+
    '</div>'
  ).join('');
}

/* ── session inspector ───────────────────────────────────── */
async function loadSession() {
  const id = document.getElementById('sess-id').value.trim();
  if (!id) return;
  const msgs = document.getElementById('sess-messages');
  const taskDiv = document.getElementById('task-info');
  msgs.innerHTML = '<span class="spinner"></span>';
  taskDiv.style.display = 'none';

  const data = await api('/session/' + encodeURIComponent(id))
    .catch(e => {
      msgs.innerHTML = '<div style="color:#f85149">'+esc(e.message)+'</div>';
      return null;
    });
  if (!data) return;

  const messages = data.messages || [];
  if (!messages.length) {
    msgs.innerHTML = '<div id="sess-placeholder">No messages found</div>';
    return;
  }
  msgs.innerHTML = messages.map(m => {
    const role = m.role || 'system';
    return '<div class="msg '+esc(role)+'"><div class="msg-role">'+esc(role)+'</div>'+
      esc(m.content || m.text || '')+'</div>';
  }).join('');

  if (data.activeTask) {
    taskDiv.style.display = 'block';
    taskDiv.textContent = '⚙ Active task: ' + (data.activeTask.taskId || data.activeTask.id || '?') +
      ' — ' + (data.activeTask.status || '?');
  }
}

/* ── utils ───────────────────────────────────────────────── */
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── auto-login if cached ────────────────────────────────── */
if (S.password) {
  submitLogin();
}
</script>
</body>
</html>`;
}
