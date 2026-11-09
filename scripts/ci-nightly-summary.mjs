import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

let summary = "# 夜间性能报告\n\n";
try {
	const id = readFileSync(process.env.AEVIA_CI_RUN_ID_FILE, "utf8").trim();
	if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid run ID");
	const report = JSON.parse(readFileSync(path.join("tests/reports/summary/runs", id, "lab-report.json"), "utf8"));
	if (report.run?.id !== id) throw new Error("Report run ID mismatch");
	const diagnostic = process.env.AEVIA_LAB_DIAGNOSTIC === "1";
	summary += diagnostic ? "**托管机器观测：结果不可用于正式性能达标或跨宿主回归判定，不写入历史。**\n\n" : `性能资格：${report.run.performanceVerdict ?? "inconclusive"}\n\n`;
	summary += `运行状态：${report.run.status}；采集有效性：${report.run.validity?.status}；用例：${report.gate?.cases?.length ?? 0}；指标：${report.measurements?.length ?? 0}。\n\n`;
	const measurements = (report.measurements ?? []).filter(m => m.suite === "performance-external" && /visuallyStableMs|firstNonBlankMs|worstRecovery|peakJsHeap|survived/i.test(m.metric)).slice(0, 25);
	if (measurements.length) {
		summary += "| 用例 | 环境 | 指标 | 数值 | 来源 |\n| --- | --- | --- | ---: | --- |\n";
		for (const m of measurements) summary += `| ${String(m.id).replaceAll("|", "\\|")} | ${m.env ?? "—"} | ${m.metric} | ${typeof m.value === "number" ? Number(m.value.toFixed(2)) : "—"} | ${m.source ?? "—"} |\n`;
		summary += "\n";
	}
	summary += `完整指标、采样和截图：下载产物后打开 \`${id}/lab-report.html\`；各性能场景的详细 HTML 位于同目录的 \`external/\`。\n`;
} catch (error) {
	summary += `未能读取本次性能报告：${error instanceof Error ? error.message : String(error)}。请查看任务日志和产物。\n`;
}
if (process.env.AEVIA_CI_ARTIFACT_URL) summary += `\n[下载完整报告](${process.env.AEVIA_CI_ARTIFACT_URL})\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
else console.log(summary);
