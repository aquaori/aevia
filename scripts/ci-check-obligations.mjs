import fs from "node:fs";
import path from "node:path";
import { analyzeChangeObligations } from "../tests/lab/change-obligations";

const parseCliArgs = () => {
	const args = process.argv.slice(2);
	let baseSha = process.env.CI_BASE || undefined;
	let headSha = process.env.CI_HEAD || undefined;
	let stagedOnly = false;
	let jsonOut = undefined;
	let markdownOut = process.env.AEVIA_CHANGE_SUMMARY_OUTPUT || undefined;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--staged") {
			stagedOnly = true;
		} else if (arg.startsWith("--base=")) {
			baseSha = arg.slice("--base=".length);
		} else if (arg === "--base" && args[i + 1]) {
			baseSha = args[i + 1];
			i += 1;
		} else if (arg.startsWith("--head=")) {
			headSha = arg.slice("--head=".length);
		} else if (arg === "--head" && args[i + 1]) {
			headSha = args[i + 1];
			i += 1;
		} else if (arg.startsWith("--json=")) {
			jsonOut = arg.slice("--json=".length);
		} else if (arg === "--json" && args[i + 1]) {
			jsonOut = args[i + 1];
			i += 1;
		} else if (arg.startsWith("--markdown=")) {
			markdownOut = arg.slice("--markdown=".length);
		} else if (arg === "--markdown" && args[i + 1]) {
			markdownOut = args[i + 1];
			i += 1;
		}
	}

	return { baseSha, headSha, stagedOnly, jsonOut, markdownOut };
};

const { baseSha, headSha, stagedOnly, jsonOut, markdownOut } = parseCliArgs();
const rootDir = process.cwd();
const analysis = analyzeChangeObligations({
	rootDir,
	baseSha,
	headSha,
	stagedOnly,
});

if (jsonOut) {
	const absJson = path.resolve(rootDir, jsonOut);
	fs.mkdirSync(path.dirname(absJson), { recursive: true });
	fs.writeFileSync(absJson, `${JSON.stringify(analysis.report, null, 2)}\n`, "utf8");
}

if (markdownOut) {
	const absMd = path.resolve(rootDir, markdownOut);
	fs.mkdirSync(path.dirname(absMd), { recursive: true });
	fs.writeFileSync(absMd, `${analysis.markdown}\n`, "utf8");
}

console.log(analysis.markdown);

if (!analysis.report.passed) {
	console.error(
		`\n[ci-check-obligations] 检查失败：共发现 ${analysis.report.violations.length} 项测试义务问题，请按上方指引修复后重试。`,
	);
	process.exit(1);
}

console.log(
	`\n[ci-check-obligations] 检查通过：关联源码 ${analysis.report.summary.changedSources} 个，选中测试目标 ${analysis.report.summary.selectedCount} 项。`,
);
