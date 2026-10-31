// File role: single-page HTML shell for the temporary live test console (served by live-console.ts).
//
// Light "toB dashboard" styling, but the page is an app shell: the viewport never scrolls on
// desktop, every panel scrolls internally, and the pipeline console stays pinned at the bottom
// so a long E2E case list can never push the live log out of view. The console itself is a
// terminal-style pane: monospaced, timestamped, colour-coded, auto-following (pausable).
// Dependency-free and served from a loopback HTTP server; the initial snapshot is embedded so the
// page is useful before the WebSocket handshake completes.

export type LiveConsolePageModel = {
	runId: string;
	mode: string;
	profile: string;
	revision?: string;
	startedAt: string;
	steps: Array<{ id: string; title: string; status: string }>;
	token: string;
	wsPath: string;
};

const initialSnapshot = (model: LiveConsolePageModel) => ({
	runId: model.runId,
	mode: model.mode,
	profile: model.profile,
	startedAt: model.startedAt,
	steps: model.steps.map((step, index) => ({ ...step, index: index + 1 })),
});

export const renderLiveConsoleHtml = (model: LiveConsolePageModel) => {
	const initialJson = JSON.stringify(initialSnapshot(model)).replace(/<\//g, "<\\/");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aevia Lab · 实时测试流水线</title>
<style>
:root{
  --bg:#eef2f8;--surface:#fff;--surface-2:#f7f9fc;--border:#e2e8f0;--border-strong:#cfd8e3;
  --text:#1e293b;--muted:#64748b;--subtle:#94a3b8;--primary:#2563eb;
  --success:#16a34a;--success-soft:#f0fdf4;--danger:#dc2626;--danger-soft:#fef2f2;
  --warning:#d97706;--warning-soft:#fffbeb;--radius:12px;
  --shadow:0 1px 2px rgba(15,23,42,.04),0 1px 3px rgba(15,23,42,.06);
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
code,.mono,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.shell{height:100vh;display:flex;flex-direction:column;overflow:hidden}
.appbar{flex:0 0 auto;background:rgba(255,255,255,.94);border-bottom:1px solid var(--border);backdrop-filter:blur(10px)}
.appbar-inner{max-width:1580px;margin:0 auto;height:58px;padding:0 20px;display:flex;align-items:center;gap:14px}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:15px;white-space:nowrap}
.brand-mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;display:grid;place-items:center;font-size:13px;font-weight:800}
.brand .sub{font-weight:400;color:var(--muted);font-size:12px;margin-left:2px}
.meta-chips{display:flex;gap:7px;flex-wrap:nowrap;overflow:hidden;align-items:center}
.chip{display:inline-flex;align-items:center;gap:5px;height:25px;padding:0 9px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border);color:var(--muted);font-size:11.5px;white-space:nowrap}
.chip b{color:var(--text);font-weight:600}
.spacer{flex:1}
.toolbar{display:flex;align-items:center;gap:8px;white-space:nowrap}
.elapsed{font-variant-numeric:tabular-nums;color:var(--muted);font-size:11.5px;display:inline-flex;gap:5px;align-items:center}
.elapsed b{color:var(--text);font-size:12.5px}
.badge{display:inline-flex;align-items:center;gap:6px;height:25px;padding:0 10px;border-radius:999px;font-size:11.5px;font-weight:600;border:1px solid transparent}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.running{color:#2563eb;background:#eff6ff;border-color:#bfdbfe}
.badge.passed{color:var(--success);background:var(--success-soft);border-color:#bbf7d0}
.badge.failed{color:var(--danger);background:var(--danger-soft);border-color:#fecaca}
.badge.cancelled{color:var(--warning);background:var(--warning-soft);border-color:#fde68a}
.badge.conn{color:var(--muted);background:var(--surface-2);border-color:var(--border)}
.badge.conn.live{color:var(--success);background:var(--success-soft);border-color:#bbf7d0}
button{font:inherit;font-size:12.5px;border-radius:8px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);padding:5px 11px;cursor:pointer;transition:background .15s,border-color .15s}
button:hover{background:var(--surface-2);border-color:#bcc6d4}
button:disabled{opacity:.5;cursor:not-allowed}
button.danger{color:var(--danger);border-color:#fecaca;background:#fff}
button.danger:hover{background:var(--danger-soft)}
.page{flex:1;min-height:0;width:100%;max-width:1580px;margin:0 auto;padding:12px 20px 14px;display:flex;flex-direction:column;gap:12px}
.grid-kpis{flex:0 0 auto;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);padding:9px 14px;display:flex;flex-direction:column;gap:1px;min-width:0}
.stat .label{color:var(--muted);font-size:11.5px}
.stat .value{font-size:22px;font-weight:700;line-height:1.25;font-variant-numeric:tabular-nums}
.stat.success .value{color:var(--success)}.stat.danger .value{color:var(--danger)}.stat.primary .value{color:var(--primary)}
.stat .hint{color:var(--subtle);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.workspace{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.32fr) minmax(370px,1fr);gap:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);display:flex;flex-direction:column;min-height:0;overflow:hidden}
.card-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border)}
.card-head h2{margin:0;font-size:12.5px;font-weight:700;letter-spacing:.2px}
.card-head .count{margin-left:auto;color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.progress-row{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 14px 0}
.progress{flex:1;height:7px;border-radius:999px;background:#e8edf5;overflow:hidden}
.progress>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2563eb,#7c3aed);border-radius:999px;transition:width .3s ease}
.progress-num{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:36px;text-align:right}
.list{list-style:none;margin:0;padding:0;flex:1;min-height:0;overflow:auto}
.row{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid #eef2f7;flex:0 0 auto}
.row:last-child{border-bottom:0}
.row.step:hover{background:var(--surface-2)}
.row.step.running{background:#eff6ff}
.row.step.failed{background:#fffafa}
.idx{width:20px;color:var(--subtle);font-size:11px;text-align:right;font-variant-numeric:tabular-nums}
.icon{width:18px;height:18px;flex:0 0 18px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:700;border:1px solid var(--border);color:var(--subtle);background:var(--surface-2)}
.icon.running{color:#2563eb;border-color:#bfdbfe;background:#eff6ff;animation:pulse 1.4s ease-in-out infinite}
.icon.passed{color:#fff;border-color:var(--success);background:var(--success)}
.icon.failed{color:#fff;border-color:var(--danger);background:var(--danger)}
.icon.cancelled{color:#fff;border-color:var(--warning);background:var(--warning)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,.35)}50%{box-shadow:0 0 0 4px rgba(37,99,235,0)}}
.main{flex:1;min-width:0}
.title{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{color:var(--muted);font-size:11px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.status-text{font-size:11.5px;color:var(--muted);white-space:nowrap}
.status-text.passed{color:var(--success)}.status-text.failed{color:var(--danger)}.status-text.running{color:#2563eb}.status-text.cancelled{color:var(--warning)}
.dur{font-size:11.5px;color:var(--subtle);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:44px;text-align:right}
.right-stack{display:flex;flex-direction:column;gap:12px;min-height:0}
.cases-card{flex:1;min-height:0}
.case-badge{font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:999px;white-space:nowrap}
.case-badge.passed{color:var(--success);background:var(--success-soft)}
.case-badge.failed{color:var(--danger);background:var(--danger-soft)}
.empty{padding:22px 14px;text-align:center;color:var(--subtle);font-size:11.5px}
.info-card{flex:0 0 auto}
.info{display:grid;grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr);gap:3px 10px;padding:9px 14px 11px;margin:0;font-size:11px}
.info dt{color:var(--muted);white-space:nowrap}
.info dd{margin:0;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.info .span2{grid-column:span 3}
/* ---- pipeline console ---- */
.log-card{flex:0 0 clamp(200px,32vh,360px);min-height:0;border-color:#1b2433;background:#0b1220;box-shadow:0 6px 18px rgba(8,15,30,.16)}
.log-bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:7px 12px;background:#0f172a;border-bottom:1px solid #1b2433;color:#8b98ab;font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dot{width:9px;height:9px;border-radius:50%}
.dot.r{background:#ef4444}.dot.y{background:#f59e0b}.dot.g{background:#22c55e}
.log-title{color:#cbd5e1;font-weight:600;margin-left:2px}
.log-step{color:#7dd3fc;background:#0b1a2b;border:1px solid #16324d;border-radius:5px;padding:0 7px;line-height:19px;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.log-spacer{flex:1}
.log-count{color:#64748b;font-variant-numeric:tabular-nums}
.chip-btn{font-size:11px;padding:2px 8px;border-radius:6px;background:#111c30;border:1px solid #22304a;color:#9fb0c7;font-family:inherit}
.chip-btn:hover{background:#152238;border-color:#2d3f5f}
.chip-btn.active{color:#86efac;border-color:#1f4d2b;background:#0f2417}
.log{flex:1;min-height:0;overflow:auto;padding:8px 12px 12px;margin:0;color:#cbd5e1;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12px;line-height:1.62;white-space:pre-wrap;word-break:break-word;scrollbar-width:thin;scrollbar-color:#334155 transparent}
.list{scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent}
.list::-webkit-scrollbar,.log::-webkit-scrollbar{width:9px;height:9px}
.list::-webkit-scrollbar-thumb{border-radius:8px;background:#cbd5e1;border:2px solid transparent;background-clip:content-box}
.list::-webkit-scrollbar-thumb:hover{background:#94a3b8;background-clip:content-box}
.log::-webkit-scrollbar-thumb{border-radius:8px;background:#334155;border:2px solid transparent;background-clip:content-box}
.ln{display:flex;gap:10px;align-items:flex-start}
.ln .ts{flex:0 0 92px;color:#475569;font-size:11px;line-height:1.7;user-select:none}
.ln .msg{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.ln.ok .msg{color:#86efac}
.ln.err .msg{color:#fca5a5}
.ln.warn .msg{color:#fcd34d}
.ln.meta .msg{color:#7dd3fc}
.ln.dim .msg{color:#64748b}
.ln.divider{color:#3b4a63;font-size:11px;margin:4px 0 2px}
.ln.divider .msg{color:#64748b}
.log .placeholder{color:#64748b}
.done{flex:0 0 auto;border:1px solid var(--border);border-radius:10px;background:var(--surface);box-shadow:var(--shadow);padding:10px 14px;display:none}
.done.show{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.done.passed{border-left:4px solid var(--success)}
.done.failed{border-left:4px solid var(--danger)}
.done.cancelled{border-left:4px solid var(--warning)}
.done-head{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;white-space:nowrap}
.done-head .dot{width:9px;height:9px;border-radius:50%;background:currentColor}
.done.passed .done-head{color:var(--success)}.done.failed .done-head{color:var(--danger)}.done.cancelled .done-head{color:var(--warning)}
.done-summary{color:var(--muted);font-size:11.5px;flex:1;min-width:220px}
.done-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
a.btn{display:inline-flex;align-items:center;gap:6px;text-decoration:none;background:var(--primary);color:#fff;border:1px solid var(--primary);border-radius:8px;padding:5px 13px;font-weight:600;font-size:12.5px}
a.btn:hover{background:#1d4ed8}
.report-path{color:var(--subtle);font-size:11px;max-width:34vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hidden{display:none!important}
@media (max-width:1180px){
  .shell{height:auto;min-height:100vh;overflow:visible}
  .workspace{grid-template-columns:1fr}
  .grid-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .cases-card,.log-card{flex:none}
  .cases-card{max-height:320px}
  .log-card{height:42vh;min-height:240px}
  .meta-chips{flex-wrap:wrap;overflow:visible}
  .appbar-inner{height:auto;padding:9px 14px;flex-wrap:wrap}
}
</style>
</head>
<body>
<div class="shell">
  <header class="appbar"><div class="appbar-inner">
    <div class="brand"><span class="brand-mark">A</span>Aevia Lab<span class="sub">实时测试流水线</span></div>
    <div class="meta-chips">
      <span class="chip">run <b>${escapeHtml(model.runId.slice(0, 8))}</b></span>
      <span class="chip">profile <b>${escapeHtml(model.profile)}</b></span>
      <span class="chip">mode <b>${escapeHtml(model.mode)}</b></span>
      ${model.revision ? `<span class="chip">rev <b>${escapeHtml(model.revision.slice(0, 8))}</b></span>` : ""}
    </div>
    <div class="spacer"></div>
    <div class="toolbar">
      <span class="elapsed">已运行 <b id="elapsed">00:00</b></span>
      <span class="badge running" id="run-state">running</span>
      <span class="badge conn" id="conn-state">连接中</span>
      <button class="danger" id="cancel" title="终止当前测试运行">终止测试</button>
    </div>
  </div></header>

  <div class="page">
    <div class="done" id="done">
      <div class="done-head"><span class="dot"></span><span id="done-title">测试运行结束</span></div>
      <div class="done-summary" id="done-summary"></div>
      <div class="done-actions">
        <a class="btn hidden" id="report-link" href="#" target="_blank" rel="noreferrer">打开测试报告</a>
        <button id="copy-report" disabled>复制路径</button>
        <span class="report-path" id="report-path"></span>
      </div>
    </div>

    <div class="grid-kpis">
      <div class="stat"><span class="label">总步骤</span><span class="value" id="stat-total">0</span><span class="hint">本次运行计划</span></div>
      <div class="stat success"><span class="label">已通过</span><span class="value" id="stat-passed">0</span><span class="hint">成功完成</span></div>
      <div class="stat danger"><span class="label">失败 / 取消</span><span class="value" id="stat-failed">0</span><span class="hint">失败或中断</span></div>
      <div class="stat primary"><span class="label">进度</span><span class="value" id="stat-percent">0%</span><span class="hint" id="stat-current">等待开始</span></div>
    </div>

    <div class="workspace">
      <section class="card">
        <div class="card-head"><h2>步骤</h2><span class="count" id="steps-count">0/0</span></div>
        <div class="progress-row"><div class="progress"><i id="progress-bar"></i></div><span class="progress-num" id="progress-num">0%</span></div>
        <ul class="list" id="steps" style="padding-top:6px"></ul>
      </section>

      <div class="right-stack">
        <section class="card cases-card">
          <div class="card-head"><h2>E2E 用例</h2><span class="count" id="cases-count">0</span></div>
          <ul class="list" id="cases"></ul>
          <div class="empty" id="cases-empty">等待 external suite 输出用例结果…</div>
        </section>
        <section class="card info-card">
          <div class="card-head"><h2>运行信息</h2><span class="count" id="info-step">—</span></div>
          <dl class="info">
            <dt>Run</dt><dd class="mono" title="${escapeHtml(model.runId)}">${escapeHtml(model.runId)}</dd>
            <dt>Mode</dt><dd>${escapeHtml(model.mode)}</dd>
            <dt>Profile</dt><dd>${escapeHtml(model.profile)}</dd>
            <dt>Started</dt><dd class="mono">${escapeHtml(model.startedAt)}</dd>
            ${model.revision ? `<dt>Source</dt><dd class="mono span2" title="${escapeHtml(model.revision)}">${escapeHtml(model.revision)}</dd>` : ""}
          </dl>
        </section>
      </div>
    </div>

    <section class="card log-card">
      <div class="log-bar">
        <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <span class="log-title">runner console</span>
        <span class="log-step" id="log-step">—</span>
        <span class="log-spacer"></span>
        <span class="log-count" id="log-count">0 行</span>
        <button class="chip-btn active" id="follow" title="自动滚动到最新日志">跟随中</button>
        <button class="chip-btn" id="clear-log" title="清空本地显示（不影响测试）">清屏</button>
      </div>
      <div class="log" id="log"><span class="placeholder">等待测试工具输出…</span></div>
    </section>
  </div>
</div>

<script id="lab-initial" type="application/json">${initialJson}</script>
<script>
(() => {
  const TOKEN = ${JSON.stringify(model.token)};
  const WS_PATH = ${JSON.stringify(model.wsPath)};
  const initial = (() => {
    try { return JSON.parse(document.getElementById("lab-initial").textContent || "{}"); } catch { return {}; }
  })();
  const startedAt = initial.startedAt ? Date.parse(initial.startedAt) || Date.now() : Date.now();
  const steps = new Map();
  const caseRows = new Map();
  const MAX_LOG = 1200;
  const MAX_RENDER = 600;
  let currentStep = null;
  let finished = false;
  let logLines = [];
  let reconnectAttempts = 0;
  let elapsedOverride = startedAt;
  let follow = true;

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const pad = (value) => String(value).padStart(2, "0");
  const fmtElapsed = (ms) => {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return (h > 0 ? h + ":" : "") + pad(m) + ":" + pad(s);
  };
  const fmtDuration = (ms) => (typeof ms === "number" && ms >= 0 ? (ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s") : "");
  const iconOf = (status) => ({ pending: "", running: "…", passed: "✓", failed: "✕", skipped: "–", cancelled: "!" }[status] ?? "");
  const labelOf = (status) => ({ pending: "等待中", running: "运行中", passed: "已通过", failed: "失败", skipped: "已跳过", cancelled: "已取消" }[status] ?? status);
  const clock = () => { const d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + String(d.getMilliseconds()).padStart(3, "0"); };

  for (const step of initial.steps || []) steps.set(step.id, { ...step });

  const renderStats = () => {
    const all = [...steps.values()];
    const passed = all.filter((step) => step.status === "passed").length;
    const failed = all.filter((step) => step.status === "failed" || step.status === "cancelled").length;
    const done = all.filter((step) => step.status !== "pending" && step.status !== "running").length;
    const percent = all.length === 0 ? 0 : Math.round((done / all.length) * 100);
    $("stat-total").textContent = String(all.length);
    $("stat-passed").textContent = String(passed);
    $("stat-failed").textContent = String(failed);
    $("stat-percent").textContent = percent + "%";
    $("progress-bar").style.width = percent + "%";
    $("progress-num").textContent = percent + "%";
    $("steps-count").textContent = done + "/" + all.length;
    const running = all.find((step) => step.status === "running");
    $("stat-current").textContent = finished ? "已结束" : running ? "正在执行：" + (running.title || running.id) : "等待开始";
    if (running) $("info-step").textContent = running.title || running.id;
  };

  const renderSteps = () => {
    const list = $("steps");
    list.innerHTML = "";
    for (const step of steps.values()) {
      const li = document.createElement("li");
      li.className = "row step " + step.status;
      li.innerHTML =
        '<span class="idx">' + (step.index || "") + "</span>" +
        '<span class="icon ' + esc(step.status) + '">' + esc(iconOf(step.status)) + "</span>" +
        '<div class="main"><div class="title">' + esc(step.title || step.id) + "</div>" +
        (step.error ? '<div class="sub">' + esc(step.error) + "</div>" : "") + "</div>" +
        '<span class="status-text ' + esc(step.status) + '">' + esc(labelOf(step.status)) + "</span>" +
        '<span class="dur">' + esc(fmtDuration(step.durationMs)) + "</span>";
      list.appendChild(li);
    }
    renderStats();
  };

  const renderCases = () => {
    const list = $("cases");
    const empty = $("cases-empty");
    list.querySelectorAll("li.row").forEach((node) => node.remove());
    $("cases-count").textContent = String(caseRows.size);
    if (caseRows.size === 0) { empty.classList.remove("hidden"); return; }
    empty.classList.add("hidden");
    const ordered = [...caseRows.values()].sort((left, right) => {
      if (left.status === right.status) return 0;
      return left.status === "failed" ? -1 : 1;
    });
    for (const item of ordered) {
      const li = document.createElement("li");
      li.className = "row case";
      li.innerHTML =
        '<span class="icon ' + (item.status === "passed" ? "passed" : "failed") + '">' + (item.status === "passed" ? "✓" : "✕") + "</span>" +
        '<div class="main"><div class="title">' + esc(item.id) + "</div>" + (item.error ? '<div class="sub">' + esc(item.error) + "</div>" : "") + "</div>" +
        '<span class="case-badge ' + esc(item.status) + '">' + (item.status === "passed" ? "通过" : "失败") + "</span>" +
        '<span class="dur">' + esc(fmtDuration(item.durationMs)) + "</span>";
      list.appendChild(li);
    }
  };

  const classify = (text, stderr) => {
    if (/\\[lab\\]\\[(invalid-case|abort)\\]|(^|\\s)✕/.test(text)) return "err";
    if (stderr || /^\\[stderr\\]/.test(text)) return "warn";
    if (/^✓|\\bpassed\\b/.test(text)) return "ok";
    if (/^•|^▶|^\\[services\\]/.test(text)) return "meta";
    if (/^\\s*$/.test(text)) return "dim";
    return "";
  };

  const renderLog = () => {
    const node = $("log");
    if (logLines.length === 0) { node.innerHTML = '<span class="placeholder">等待测试工具输出…</span>'; $("log-count").textContent = "0 行"; return; }
    $("log-count").textContent = logLines.length + " 行";
    const visible = logLines.slice(-MAX_RENDER);
    node.innerHTML = visible
      .map((line) => {
        if (line.divider) return '<div class="ln divider"><span class="msg">──── ' + esc(line.text) + " ────</span></div>";
        return '<div class="ln ' + (line.kind || "") + '"><span class="ts">' + esc(line.t) + '</span><span class="msg">' + esc(line.text) + "</span></div>";
      })
      .join("");
    if (follow) node.scrollTop = node.scrollHeight;
  };

  const appendLog = (lines, stepId) => {
    // Continuous pipeline log: step switches add a divider instead of clearing, so the run
    // keeps scrolling like a CI console. The "清屏" button is the explicit reset.
    if (stepId && currentStep !== stepId) {
      currentStep = stepId;
      $("log-step").textContent = stepId;
      const title = steps.get(stepId)?.title || stepId;
      logLines.push({ divider: true, text: title });
    }
    for (const raw of lines) {
      const text = typeof raw === "string" ? raw : raw.text;
      if (typeof text !== "string" || text.length === 0) continue;
      const stderr = typeof raw === "object" && raw !== null && raw.err;
      logLines.push({ t: clock(), text, kind: classify(text, stderr) });
    }
    if (logLines.length > MAX_LOG) logLines = logLines.slice(-MAX_LOG);
    renderLog();
  };

  const updateFollow = () => {
    const button = $("follow");
    button.classList.toggle("active", follow);
    button.textContent = follow ? "跟随中" : "已暂停";
  };
  $("follow").addEventListener("click", () => {
    follow = !follow;
    updateFollow();
    if (follow) $("log").scrollTop = $("log").scrollHeight;
  });
  $("clear-log").addEventListener("click", () => {
    logLines = [];
    renderLog();
  });
  $("log").addEventListener("scroll", () => {
    const node = $("log");
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    if (follow && !nearBottom) { follow = false; updateFollow(); }
    else if (!follow && nearBottom) { follow = true; updateFollow(); }
  });

  const setState = (state) => {
    const node = $("run-state");
    node.className = "badge " + state;
    node.textContent = state;
    if (state === "passed" || state === "failed" || state === "cancelled") {
      finished = true;
      $("cancel").disabled = true;
    }
  };

  const setConn = (state) => {
    const node = $("conn-state");
    if (state === "live") { node.className = "badge conn live"; node.textContent = "已连接"; return; }
    if (state === "retry") { node.className = "badge conn"; node.textContent = "连接中断，重试中"; return; }
    if (state === "idle") { node.className = "badge conn"; node.textContent = "已结束"; return; }
    node.className = "badge conn"; node.textContent = "连接中";
  };

  const connect = () => {
    let socket;
    try {
      const base = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + WS_PATH;
      socket = new WebSocket(base + "?token=" + encodeURIComponent(TOKEN));
    } catch { setConn("retry"); return; }
    socket.addEventListener("open", () => { reconnectAttempts = 0; setConn("live"); });
    socket.addEventListener("close", () => {
      setConn(finished ? "idle" : "retry");
      if (finished || reconnectAttempts >= 5) return;
      reconnectAttempts += 1;
      setTimeout(connect, Math.min(2500, 300 * reconnectAttempts));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      handle(message);
    });
    return socket;
  };

  let socket = null;
  const send = (payload) => { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); };

  const applyDone = (done) => {
    setState(done.status === "passed" ? "passed" : done.status === "cancelled" ? "cancelled" : "failed");
    const panel = $("done");
    panel.className = "done show " + (done.status === "passed" ? "passed" : done.status === "cancelled" ? "cancelled" : "failed");
    $("done-title").textContent = done.status === "passed" ? "测试通过" : done.status === "cancelled" ? "测试已终止" : "测试失败";
    $("done-summary").textContent =
      "status = " + done.status +
      (done.validity ? " · measurement = " + done.validity : "") +
      (typeof done.recorded === "boolean" ? " · recorded = " + (done.recorded ? "yes" : "no") : "") +
      (typeof done.exitCode === "number" ? " · exit = " + done.exitCode : "");
    if (done.reportUrl) {
      const link = $("report-link");
      link.href = done.reportUrl;
      link.classList.remove("hidden");
    }
    if (done.reportPath) {
      $("report-path").textContent = done.reportPath;
      const copy = $("copy-report");
      copy.disabled = false;
      copy.addEventListener("click", () => {
        if (navigator.clipboard) navigator.clipboard.writeText(done.reportPath);
        copy.textContent = "已复制";
      });
    }
    if (done.status !== "cancelled") $("cancel").textContent = "已结束";
    renderStats();
    document.title = (done.status === "passed" ? "✓ " : "✕ ") + "Aevia Lab · 实时测试流水线";
  };

  const handle = (message) => {
    if (message.type === "hello") {
      for (const step of message.steps || []) steps.set(step.id, { ...(steps.get(step.id) || {}), ...step });
      for (const item of message.cases || []) caseRows.set(item.id, item);
      if (message.status) setState(message.status);
      if (message.startedAt) elapsedOverride = Date.parse(message.startedAt) || elapsedOverride;
      if (message.done) applyDone(message.done);
      renderSteps(); renderCases();
      return;
    }
    if (message.type === "step" && message.step) {
      steps.set(message.step.id, { ...(steps.get(message.step.id) || {}), ...message.step });
      renderSteps();
      return;
    }
    if (message.type === "log") { appendLog(message.lines || [], message.stepId); return; }
    if (message.type === "case" && message.case) { caseRows.set(message.case.id, message.case); renderCases(); return; }
    if (message.type === "state" && message.status) { setState(message.status); renderStats(); return; }
    if (message.type === "done") { applyDone(message); return; }
    if (message.type === "cancel-requested") {
      $("cancel").disabled = true;
      $("cancel").textContent = "正在终止…";
    }
  };

  $("cancel").addEventListener("click", () => {
    if (finished) return;
    if (!confirm("确认终止当前测试运行？已完成的日志与结果仍会保留。")) return;
    send({ type: "cancel" });
    $("cancel").disabled = true;
    $("cancel").textContent = "正在终止…";
  });

  renderSteps();
  renderCases();
  updateFollow();
  socket = connect();
  setInterval(() => {
    if (!finished) $("elapsed").textContent = fmtElapsed(Date.now() - elapsedOverride);
  }, 500);
})();
</script>
</body>
</html>`;
};

const escapeHtml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
