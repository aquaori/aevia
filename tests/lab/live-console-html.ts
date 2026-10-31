// File role: single-page HTML shell for the temporary live test console (served by live-console.ts).
//
// The page is intentionally dependency-free: it is served from a loopback HTTP server, connects back
// over a WebSocket, renders step/case progress live, can request cancellation, and finally shows the
// report link pushed by the runner.

export type LiveConsolePageModel = {
	runId: string;
	mode: string;
	profile: string;
	token: string;
	wsPath: string;
};

export const renderLiveConsoleHtml = (model: LiveConsolePageModel) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aevia Lab · ${escapeHtml(model.runId.slice(0, 8))}</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#2a313c;--text:#e6edf3;--muted:#8b949e;--accent:#5e6ad2;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--run:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{position:sticky;top:0;z-index:5;background:rgba(13,17,23,.94);border-bottom:1px solid var(--line);padding:14px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;backdrop-filter:blur(6px)}
h1{font-size:14px;margin:0;font-weight:700;letter-spacing:.4px}
.chip{border:1px solid var(--line);border-radius:999px;padding:2px 9px;color:var(--muted);font-size:11px}
.chip b{color:var(--text);font-weight:600}
.state{margin-left:auto;display:flex;gap:10px;align-items:center}
.badge{border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;border:1px solid var(--line);color:var(--muted)}
.badge.running{color:var(--run);border-color:#1f3b5c;background:#0f2233}
.badge.passed{color:var(--ok);border-color:#1f4d2b;background:#0f2417}
.badge.failed{color:var(--bad);border-color:#5c2320;background:#2a1211}
.badge.cancelled{color:var(--warn);border-color:#5c4a1f;background:#241f0f}
button{font:inherit;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);padding:6px 12px;cursor:pointer}
button:hover{border-color:#3d4654}
button:disabled{opacity:.45;cursor:not-allowed}
button.danger{border-color:#5c2320;color:var(--bad)}
main{padding:18px 20px 40px;max-width:1280px;margin:0 auto}
.meta{color:var(--muted);font-size:11px;margin:0 0 14px;word-break:break-all}
.progress{height:6px;border-radius:999px;background:#1c222b;overflow:hidden;margin-bottom:16px}
.progress>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#5e6ad2,#58a6ff);transition:width .25s ease}
.grid{display:grid;grid-template-columns:minmax(320px,1fr) minmax(420px,1.35fr);gap:16px;align-items:start}
@media (max-width:980px){.grid{grid-template-columns:1fr}}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
section>h2{margin:0;padding:10px 14px;font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center}
section>h2 .count{margin-left:auto;font-weight:400}
ul{list-style:none;margin:0;padding:0;max-height:62vh;overflow:auto}
li.step{display:flex;gap:10px;align-items:flex-start;padding:9px 14px;border-bottom:1px solid #1d232c}
li.step:last-child{border-bottom:0}
.icon{flex:0 0 16px;width:16px;text-align:center;line-height:20px}
.icon.pending{color:#4d5560}.icon.running{color:var(--run)}.icon.passed{color:var(--ok)}.icon.failed{color:var(--bad)}.icon.skipped{color:#4d5560}.icon.cancelled{color:var(--warn)}
.step-title{flex:1}
.step-sub{display:block;color:var(--muted);font-size:11px;margin-top:2px;word-break:break-word}
.dur{color:var(--muted);font-size:11px;white-space:nowrap}
li.case{display:flex;gap:9px;align-items:center;padding:8px 14px;border-bottom:1px solid #1d232c}
li.case:last-child{border-bottom:0}
.case-id{flex:1;word-break:break-all}
.case .dur{font-size:11px}
.log{margin:0;padding:12px 14px;height:34vh;overflow:auto;background:#0b0f14;color:#c9d1d9;font-size:12px;white-space:pre-wrap;word-break:break-word}
.log .err{color:#ffaba8}
.empty{padding:18px 14px;color:var(--muted);font-size:12px}
.done{margin-top:16px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;display:none}
.done.show{display:block}
.done h3{margin:0 0 8px;font-size:14px}
.done .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
.done a.btn{text-decoration:none;display:inline-block;border-radius:8px;border:1px solid #3b4b8f;background:#1b2350;color:#cfd7ff;padding:7px 14px;font-weight:600}
.done code{color:var(--muted);font-size:11px;word-break:break-all}
footer{color:#4d5560;font-size:11px;padding:0 20px 24px;max-width:1280px;margin:0 auto}
.hidden{display:none}
</style>
</head>
<body>
<header>
  <h1>Aevia Lab <span style="color:var(--muted);font-weight:400">live run</span></h1>
  <span class="chip">run <b>${escapeHtml(model.runId.slice(0, 8))}</b></span>
  <span class="chip">profile <b>${escapeHtml(model.profile)}</b></span>
  <span class="chip">mode <b>${escapeHtml(model.mode)}</b></span>
  <span class="chip" id="elapsed">00:00</span>
  <span class="state">
    <span class="badge running" id="run-state">running</span>
    <span class="badge" id="conn-state" title="websocket link">connecting</span>
    <button class="danger" id="cancel" title="终止当前测试运行">终止测试</button>
  </span>
</header>
<main>
  <p class="meta">run ${escapeHtml(model.runId)} · token 已隐藏 · 本页面在测试结束后会保留一小段时间用于打开报告</p>
  <div class="progress"><i id="progress-bar"></i></div>
  <div class="grid">
    <section>
      <h2>步骤 <span class="count" id="steps-count"></span></h2>
      <ul id="steps"></ul>
    </section>
    <section>
      <h2>E2E 用例 <span class="count" id="cases-count"></span></h2>
      <ul id="cases"><li class="empty" id="cases-empty">等待 external suite 输出…</li></ul>
    </section>
    <section style="grid-column:1/-1">
      <h2>当前步骤输出 <span class="count" id="log-step"></span></h2>
      <pre class="log" id="log"></pre>
    </section>
  </div>
  <div class="done" id="done">
    <h3 id="done-title">测试运行结束</h3>
    <div id="done-summary" style="color:var(--muted)"></div>
    <div class="row">
      <a class="btn hidden" id="report-link" href="#" target="_blank" rel="noreferrer">打开测试报告</a>
      <button id="copy-report" disabled>复制报告路径</button>
      <code id="report-path"></code>
    </div>
  </div>
</main>
<footer>Aevia lab runner · 页面仅监听 127.0.0.1，随测试进程结束而关闭</footer>
<script>
(() => {
  const TOKEN = ${JSON.stringify(model.token)};
  const WS_PATH = ${JSON.stringify(model.wsPath)};
  const startedAt = Date.now();
  const steps = new Map();
  const caseRows = new Map();
  let currentStep = null;
  let finished = false;
  let logLines = [];
  let reconnectAttempts = 0;

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
  const fmtDuration = (ms) => (typeof ms === "number" && ms >= 0 ? (ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s") : "");
  const iconOf = (status) => ({ pending: "○", running: "◐", passed: "✓", failed: "✕", skipped: "–", cancelled: "!" }[status] || "○");

  const renderProgress = () => {
    const all = [...steps.values()];
    const done = all.filter((step) => step.status !== "pending" && step.status !== "running").length;
    $("progress-bar").style.width = all.length === 0 ? "0%" : (done / all.length) * 100 + "%";
    $("steps-count").textContent = done + "/" + all.length;
  };

  const renderSteps = () => {
    const list = $("steps");
    list.innerHTML = "";
    for (const step of steps.values()) {
      const li = document.createElement("li");
      li.className = "step";
      const sub = step.error ? '<span class="step-sub">' + esc(step.error) + "</span>" : "";
      li.innerHTML =
        '<span class="icon ' + esc(step.status) + '">' + iconOf(step.status) + "</span>" +
        '<span class="step-title">' + esc(step.title || step.id) + sub + "</span>" +
        '<span class="dur">' + esc(fmtDuration(step.durationMs)) + "</span>";
      list.appendChild(li);
    }
    renderProgress();
  };

  const renderCases = () => {
    const list = $("cases");
    const empty = $("cases-empty");
    if (caseRows.size === 0) { if (empty) empty.classList.remove("hidden"); return; }
    if (empty) empty.classList.add("hidden");
    list.querySelectorAll("li.case").forEach((node) => node.remove());
    for (const item of caseRows.values()) {
      const li = document.createElement("li");
      li.className = "case";
      li.innerHTML =
        '<span class="icon ' + (item.status === "passed" ? "passed" : "failed") + '">' + (item.status === "passed" ? "✓" : "✕") + "</span>" +
        '<span class="case-id">' + esc(item.id) + "</span>" +
        '<span class="dur">' + esc(fmtDuration(item.durationMs)) + "</span>";
      list.appendChild(li);
    }
    $("cases-count").textContent = caseRows.size + "";
  };

  const setLog = () => {
    const node = $("log");
    node.innerHTML = logLines.map((line) => '<span class="' + (line.err ? "err" : "") + '">' + esc(line.text) + "</span>").join("\n");
    if (logLines.length > 0) node.scrollTop = node.scrollHeight;
  };
  const appendLog = (lines, stepId) => {
    if (stepId && currentStep !== stepId) { currentStep = stepId; logLines = []; $("log-step").textContent = stepId; }
    logLines.push(...lines); const limit = 260; logLines = logLines.slice(-limit);
    setLog();
  };

  const setState = (state) => {
    const node = $("run-state");
    node.className = "badge " + state;
    node.textContent = state;
    if (state === "passed" || state === "failed" || state === "cancelled") {
      finished = true;
      $("cancel").disabled = true;
      $("run-state").title = "运行已结束";
    }
  };

  const connect = () => {
    const url = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + WS_PATH + "?token=" + encodeURIComponent(TOKEN);
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => { reconnectAttempts = 0; $("conn-state").textContent = "live"; $("conn-state").className = "badge passed"; });
    ws.addEventListener("close", () => {
      $("conn-state").textContent = "closed"; $("conn-state").className = "badge";
      if (finished || reconnectAttempts >= 5) return;
      reconnectAttempts += 1;
      setTimeout(connect, Math.min(2000, 250 * reconnectAttempts));
    });
    ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      handle(message);
    });
    return ws;
  };

  let socket = null;
  const send = (payload) => { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); };

  const handle = (message) => {
    if (message.type === "hello") {
      for (const step of message.steps || []) steps.set(step.id, step);
      for (const item of message.cases || []) caseRows.set(item.id, item);
      if (message.status) setState(message.status);
      if (message.startedAt) startedAtOverride = Date.parse(message.startedAt) || startedAt;
      renderSteps(); renderCases();
      if (message.done) applyDone(message.done);
      return;
    }
    if (message.type === "step" && message.step) {
      const prev = steps.get(message.step.id) || {};
      steps.set(message.step.id, { ...prev, ...message.step });
      renderSteps();
      return;
    }
    if (message.type === "log") { appendLog(message.lines || [], message.stepId); return; }
    if (message.type === "case" && message.case) { caseRows.set(message.case.id, message.case); renderCases(); return; }
    if (message.type === "state" && message.status) { setState(message.status); return; }
    if (message.type === "done") { applyDone(message); return; }
    if (message.type === "cancel-requested") {
      $("cancel").disabled = true;
      $("cancel").textContent = "正在终止…";
    }
  };

  let startedAtOverride = startedAt;
  const applyDone = (done) => {
    setState(done.status === "passed" ? "passed" : done.status === "cancelled" ? "cancelled" : "failed");
    const panel = $("done");
    panel.classList.add("show");
    $("done-title").textContent = done.status === "passed" ? "测试通过" : done.status === "cancelled" ? "测试已终止" : "测试失败";
    $("done-summary").textContent =
      "status=" + done.status +
      (done.validity ? " · measurement=" + done.validity : "") +
      (typeof done.recorded === "boolean" ? " · recorded=" + (done.recorded ? "yes" : "no") : "") +
      (typeof done.exitCode === "number" ? " · exit=" + done.exitCode : "");
    if (done.reportUrl) {
      const link = $("report-link");
      link.href = done.reportUrl; link.classList.remove("hidden");
    }
    if (done.reportPath) {
      $("report-path").textContent = done.reportPath;
      const copy = $("copy-report");
      copy.disabled = false;
      copy.addEventListener("click", () => { navigator.clipboard && navigator.clipboard.writeText(done.reportPath); copy.textContent = "已复制"; }, { once: false });
    }
    if (done.status !== "cancelled") $("cancel").textContent = "已结束";
  };

  $("cancel").addEventListener("click", () => {
    if (finished) return;
    if (!confirm("确认终止当前测试运行？已完成的日志与结果仍会保留。")) return;
    send({ type: "cancel" });
    $("cancel").disabled = true;
    $("cancel").textContent = "正在终止…";
  });

  socket = connect();
  setInterval(() => {
    if (!finished) $("elapsed").textContent = fmtElapsed(Date.now() - startedAtOverride);
  }, 500);
  renderSteps();
})();
</script>
</body>
</html>`;

const escapeHtml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
