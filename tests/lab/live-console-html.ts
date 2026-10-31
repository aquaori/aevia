// File role: single-page HTML shell for the temporary live test console (served by live-console.ts).
//
// Light "toB dashboard" styling: white cards on a soft grey canvas, a compact app bar, KPI stats,
// table-like step and case lists, and a full-width log panel. Dependency-free and served from a
// loopback HTTP server; the initial snapshot is rendered from the server model so the page is useful
// even before the WebSocket handshake completes.

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
  --bg:#f2f5f9;--surface:#ffffff;--surface-2:#f8fafc;--border:#e3e8ef;--border-strong:#d3dae4;
  --text:#1e293b;--muted:#64748b;--subtle:#94a3b8;
  --primary:#2563eb;--primary-soft:#eff6ff;--success:#16a34a;--success-soft:#f0fdf4;
  --danger:#dc2626;--danger-soft:#fef2f2;--warning:#d97706;--warning-soft:#fffbeb;
  --run:#2563eb;--run-soft:#eff6ff;
  --shadow:0 1px 2px rgba(15,23,42,.04),0 1px 3px rgba(15,23,42,.06);
  --radius:12px;
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.appbar{position:sticky;top:0;z-index:10;background:rgba(255,255,255,.92);border-bottom:1px solid var(--border);backdrop-filter:blur(10px)}
.appbar-inner{max-width:1360px;margin:0 auto;height:60px;padding:0 24px;display:flex;align-items:center;gap:14px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px;letter-spacing:.2px}
.brand-mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;display:grid;place-items:center;font-size:13px;font-weight:800}
.brand span.sub{font-weight:400;color:var(--muted);font-size:12px;margin-left:2px}
.meta-chips{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border);color:var(--muted);font-size:12px}
.chip b{color:var(--text);font-weight:600}
.spacer{flex:1}
.toolbar{display:flex;align-items:center;gap:10px}
.elapsed{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px;display:inline-flex;align-items:center;gap:6px}
.elapsed b{color:var(--text);font-size:13px}
.badge{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid transparent}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.running{color:var(--run);background:var(--run-soft);border-color:#bfdbfe}
.badge.passed{color:var(--success);background:var(--success-soft);border-color:#bbf7d0}
.badge.failed{color:var(--danger);background:var(--danger-soft);border-color:#fecaca}
.badge.cancelled{color:var(--warning);background:var(--warning-soft);border-color:#fde68a}
.badge.conn{color:var(--muted);background:var(--surface-2);border-color:var(--border)}
.badge.conn.live{color:var(--success);background:var(--success-soft);border-color:#bbf7d0}
button{font:inherit;border-radius:9px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);padding:6px 12px;cursor:pointer;font-size:13px;transition:background .15s,border-color .15s}
button:hover{background:var(--surface-2);border-color:#bcc6d4}
button:disabled{opacity:.5;cursor:not-allowed}
button.primary{background:var(--primary);border-color:var(--primary);color:#fff;font-weight:600}
button.primary:hover{background:#1d4ed8}
button.danger{color:var(--danger);border-color:#fecaca;background:#fff}
button.danger:hover{background:var(--danger-soft);border-color:#fca5a5}
.page{max-width:1360px;margin:0 auto;padding:22px 24px 48px}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:18px;align-items:start}
.stack{display:flex;flex-direction:column;gap:18px}
.col-3{grid-column:span 3}.col-4{grid-column:span 4}.col-5{grid-column:span 5}.col-7{grid-column:span 7}.col-8{grid-column:span 8}.col-12{grid-column:span 12}
@media (max-width:1100px){.col-3,.col-4,.col-5,.col-7,.col-8{grid-column:span 12}.appbar-inner{height:auto;padding:10px 16px;flex-wrap:wrap}.page{padding:16px}}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.card-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)}
.card-head h2{margin:0;font-size:13px;font-weight:700;letter-spacing:.2px}
.card-head .count{margin-left:auto;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.card-body{padding:16px 18px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px 18px;display:flex;flex-direction:column;gap:4px}
.stat .label{color:var(--muted);font-size:12px}
.stat .value{font-size:26px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}
.stat.success .value{color:var(--success)}.stat.danger .value{color:var(--danger)}.stat.primary .value{color:var(--primary)}
.stat .hint{color:var(--subtle);font-size:11px}
.progress-wrap{display:flex;align-items:center;gap:12px}
.progress{flex:1;height:8px;border-radius:999px;background:#e8edf5;overflow:hidden}
.progress>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2563eb,#7c3aed);border-radius:999px;transition:width .3s ease}
.progress-num{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:38px;text-align:right}
.list{list-style:none;margin:0;padding:0;max-height:440px;overflow:auto}
.row{display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid #eef2f7}
.row:last-child{border-bottom:0}
.row:hover{background:var(--surface-2)}
.row.step.running{background:var(--run-soft)}
.row.step.failed{background:#fffafa}
.idx{width:22px;color:var(--subtle);font-size:12px;text-align:right;font-variant-numeric:tabular-nums}
.icon{width:20px;height:20px;flex:0 0 20px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;border:1px solid var(--border);color:var(--subtle);background:var(--surface-2)}
.icon.running{color:var(--run);border-color:#bfdbfe;background:var(--run-soft);animation:pulse 1.4s ease-in-out infinite}
.icon.passed{color:#fff;border-color:var(--success);background:var(--success)}
.icon.failed{color:#fff;border-color:var(--danger);background:var(--danger)}
.icon.skipped,.icon.pending{color:var(--subtle);background:var(--surface-2)}
.icon.cancelled{color:#fff;border-color:var(--warning);background:var(--warning)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,.35)}50%{box-shadow:0 0 0 4px rgba(37,99,235,0)}}
.main{flex:1;min-width:0}
.title{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{color:var(--muted);font-size:11.5px;margin-top:1px;word-break:break-word}
.status-text{font-size:12px;color:var(--muted);white-space:nowrap}
.status-text.passed{color:var(--success)}.status-text.failed{color:var(--danger)}.status-text.running{color:var(--run)}.status-text.cancelled{color:var(--warning)}
.dur{font-size:12px;color:var(--subtle);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:48px;text-align:right}
.case-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px}
.case-badge.passed{color:var(--success);background:var(--success-soft)}
.case-badge.failed{color:var(--danger);background:var(--danger-soft)}
.empty{padding:32px 18px;text-align:center;color:var(--subtle);font-size:12px}
.info{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;padding:16px 18px;font-size:12px}
.info dt{color:var(--muted);white-space:nowrap}
.info dd{margin:0;color:var(--text);word-break:break-all}
.log{padding:14px 18px;background:#0f172a;color:#dbe4f0;font-size:12px;line-height:1.65;height:38vh;min-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.log .err{color:#fca5a5}
.log .placeholder{color:#64748b}
.done{margin-bottom:18px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow);padding:18px 20px;display:none}
.done.show{display:block}
.done.passed{border-left:4px solid var(--success)}
.done.failed{border-left:4px solid var(--danger)}
.done.cancelled{border-left:4px solid var(--warning)}
.done-head{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700}
.done-head .dot{width:10px;height:10px;border-radius:50%}
.done.passed .dot{background:var(--success)}.done.failed .dot{background:var(--danger)}.done.cancelled .dot{background:var(--warning)}
.done-summary{color:var(--muted);font-size:12.5px;margin-top:6px}
.done-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px}
.report-path{color:var(--subtle);font-size:11.5px;word-break:break-all}
a.btn{display:inline-flex;align-items:center;gap:8px;text-decoration:none;background:var(--primary);color:#fff;border:1px solid var(--primary);border-radius:9px;padding:8px 16px;font-weight:600;font-size:13px}
a.btn:hover{background:#1d4ed8}
footer{max-width:1360px;margin:0 auto;padding:0 24px 24px;color:var(--subtle);font-size:11.5px}
.hidden{display:none!important}
</style>
</head>
<body>
<div class="appbar"><div class="appbar-inner">
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
</div></div>

<div class="page">
  <p class="meta" style="display:none">run ${escapeHtml(model.runId)}</p>
  <div class="done" id="done">
    <div class="done-head"><span class="dot"></span><span id="done-title">测试运行结束</span></div>
    <div class="done-summary" id="done-summary"></div>
    <div class="done-actions">
      <a class="btn hidden" id="report-link" href="#" target="_blank" rel="noreferrer">打开测试报告</a>
      <button id="copy-report" disabled>复制报告路径</button>
      <span class="report-path" id="report-path"></span>
    </div>
  </div>

  <div class="grid">
    <div class="col-3 stat"><span class="label">总步骤</span><span class="value" id="stat-total">0</span><span class="hint">本次运行计划</span></div>
    <div class="col-3 stat success"><span class="label">已通过</span><span class="value" id="stat-passed">0</span><span class="hint">成功完成的步骤</span></div>
    <div class="col-3 stat danger"><span class="label">失败 / 取消</span><span class="value" id="stat-failed">0</span><span class="hint">失败或中断的步骤</span></div>
    <div class="col-3 stat primary"><span class="label">进度</span><span class="value" id="stat-percent">0%</span><span class="hint" id="stat-current">等待开始</span></div>

    <div class="col-7 card">
      <div class="card-head"><h2>步骤</h2><span class="count" id="steps-count">0/0</span></div>
      <div style="padding:14px 18px 0"><div class="progress-wrap"><div class="progress"><i id="progress-bar"></i></div><span class="progress-num" id="progress-num">0%</span></div></div>
      <div style="padding:8px 0 0"><ul class="list" id="steps"></ul></div>
    </div>

    <div class="col-5 stack">
      <div class="card">
        <div class="card-head"><h2>E2E 用例</h2><span class="count" id="cases-count">0</span></div>
        <ul class="list" id="cases"></ul>
        <div class="empty" id="cases-empty">等待 external suite 输出用例结果…</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>运行信息</h2><span class="count" id="info-step">—</span></div>
        <dl class="info">
          <dt>Run ID</dt><dd class="mono">${escapeHtml(model.runId)}</dd>
          <dt>Profile</dt><dd>${escapeHtml(model.profile)}</dd>
          <dt>Mode</dt><dd>${escapeHtml(model.mode)}</dd>
          ${model.revision ? `<dt>Source</dt><dd class="mono">${escapeHtml(model.revision)}</dd>` : ""}
          <dt>Started</dt><dd class="mono">${escapeHtml(model.startedAt)}</dd>
        </dl>
      </div>
    </div>

    <div class="col-12 card">
      <div class="card-head"><h2>当前步骤实时输出</h2><span class="count" id="log-step">—</span></div>
      <pre class="log" id="log"><span class="placeholder">等待测试工具输出…</span></pre>
    </div>
  </div>
</div>
<footer>Aevia Lab Runner · 页面仅监听 127.0.0.1，测试结束后按保留策略自动关闭；完整证据见测试报告。</footer>

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
  let currentStep = null;
  let finished = false;
  let logLines = [];
  let reconnectAttempts = 0;
  let elapsedOverride = startedAt;

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
      li.className = "row step";
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

  const setLog = () => {
    const node = $("log");
    if (logLines.length === 0) { node.innerHTML = '<span class="placeholder">等待测试工具输出…</span>'; return; }
    const isErrorLine = (line) => Boolean(line.err) || /\\[lab\\]\\[(invalid-case|abort)\\]|(^|\\s)✕/.test(line.text || "");
    node.innerHTML = logLines
      .map((line) => '<span class="' + (isErrorLine(line) ? "err" : "") + '">' + esc(line.text) + "</span>")
      .join("\\n");
    node.scrollTop = node.scrollHeight;
  };
  const appendLog = (lines, stepId) => {
    if (stepId && currentStep !== stepId) { currentStep = stepId; logLines = []; $("log-step").textContent = stepId; }
    for (const line of lines) {
      logLines.push(typeof line === "string" ? { text: line } : line);
    }
    logLines = logLines.slice(-240);
    setLog();
  };

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
  socket = connect();
  setInterval(() => {
    if (!finished) $("elapsed").textContent = fmtElapsed(Date.now() - elapsedOverride);
  }, 500);
  setTimeout(() => {
    if (!finished && (!socket || socket.readyState !== WebSocket.OPEN)) {
      $("conn-state").title = "若长时间未连接，请使用终端打印的完整 URL（包含 ?token=…）";
    }
  }, 3000);
})();
</script>
</body>
</html>`;
};

const escapeHtml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
