import fs from "fs";
import path from "path";
import type { BenchmarkCaseResult } from "./core-types";
import { ensureDir } from "./core-utils";

const STATUS_LABELS: Record<string, string> = {
	ok: "通过",
	warn: "警告",
	fail: "失败",
	"no-baseline": "无基线",
};

const MODE_LABELS: Record<string, string> = {
	headless: "无头浏览器",
	headed: "有界面浏览器",
};

const ENV_LABELS: Record<string, string> = {
	gpu_cpuHigh: "GPU开启 + CPU正常",
	gpu_cpuLow: "GPU开启 + CPU降速4x",
	noGpu_cpuHigh: "GPU关闭 + CPU正常",
	noGpu_cpuLow: "GPU关闭 + CPU降速4x",
};

const SHAPE_LABELS: Record<string, string> = {
	"many-short-strokes": "大量短笔迹",
	"few-long-strokes": "少量长笔迹",
	"dense-overlap": "高密度重叠",
	"sparse-fullscreen": "全屏稀疏分布",
	"mixed-tool-history": "混合工具历史",
};

const CATEGORY_LABELS: Record<string, string> = {
	micro: "微基准",
	"full-render": "全量渲染",
	latency: "交互延迟",
	stress: "持续压测",
	collision: "碰撞自愈",
	chaos: "弱网恢复",
	visual: "视觉一致性",
	incremental: "增量渲染",
	"undo-redo": "撤销重做",
	"multi-page": "多页切换",
	eraser: "橡皮擦专项",
};

const formatMetricKey = (key: string) =>
	key
		.replace(/([A-Z])/g, " $1")
		.replace(/_/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const translateReason = (reason: string) => {
	const normalized = reason.replace(/\u001b\[[0-9;]*m/g, "").trim();
	if (normalized.includes("ERR_CONNECTION_REFUSED")) {
		return "无法连接到前端页面 `http://localhost:5173`，前端开发服务未启动或端口不可达。";
	}
	if (normalized.includes("fetch failed")) {
		return "请求失败，通常表示前端或后端基准测试依赖服务未启动。";
	}
	return normalized;
};

export const generateHtmlReport = (results: BenchmarkCaseResult[], reportDir?: string) => {
	const targetDir = reportDir || path.join(process.cwd(), "tests", "e2e", "benchmarks", "reports");
	ensureDir(targetDir);
	const filePath = path.join(targetDir, "benchmark-report.html");

	const grouped = results.reduce<Record<string, BenchmarkCaseResult[]>>((acc, result) => {
		acc[result.category] = [...(acc[result.category] || []), result];
		return acc;
	}, {});

	const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark 测试报告</title>
  <style>
    body { font-family: "Segoe UI", sans-serif; margin: 24px; background: #f8fafc; color: #0f172a; }
    h1, h2 { margin: 0 0 12px; }
    .meta { color: #475569; margin-bottom: 24px; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 14px; padding: 16px; margin-bottom: 18px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; }
    th { color: #334155; background: #f8fafc; }
    .status-ok { color: #166534; font-weight: 600; }
    .status-warn { color: #b45309; font-weight: 600; }
    .status-fail { color: #b91c1c; font-weight: 600; }
    .status-no-baseline { color: #475569; font-weight: 600; }
    code { background: #eef2ff; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>Benchmark 测试报告</h1>
  <div class="meta">生成时间：${new Date().toLocaleString()}</div>
  ${Object.entries(grouped)
		.map(
			([category, categoryResults]) => `
    <section class="card">
      <h2>${CATEGORY_LABELS[category] || category}</h2>
      <table>
        <thead>
          <tr>
            <th>测试项</th>
            <th>浏览器模式</th>
            <th>环境矩阵</th>
            <th>数据形态</th>
            <th>规模</th>
            <th>状态</th>
            <th>中位数指标</th>
            <th>原因说明</th>
          </tr>
        </thead>
        <tbody>
          ${categoryResults
				.map((result) => {
					const metrics = Object.entries(result.aggregate.numeric)
						.slice(0, 5)
						.map(([key, value]) => `<div><code>${formatMetricKey(key)}</code>: ${value.median.toFixed(2)}</div>`)
						.join("");
					return `
              <tr>
                <td>${result.id}</td>
                <td>${MODE_LABELS[result.runMode] || result.runMode}</td>
                <td>${ENV_LABELS[result.environment] || result.environment}</td>
                <td>${SHAPE_LABELS[result.shape] || result.shape}</td>
                <td>${result.scale ?? "-"}</td>
                <td class="status-${result.diff.status}">${STATUS_LABELS[result.diff.status] || result.diff.status}</td>
                <td>${metrics || "无有效指标"}</td>
                <td>${result.diff.reasons.map(translateReason).join("<br/>")}</td>
              </tr>`;
				})
				.join("")}
        </tbody>
      </table>
    </section>`
		)
		.join("")}
</body>
</html>`;

	fs.writeFileSync(filePath, html, "utf-8");
	return filePath;
};
