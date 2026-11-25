import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SourceMap } from "node:module";
import path from "node:path";
import type { openRoomPage } from "../../apps/frontend/tests/e2e/external/ui-driver";
import { execFileSync } from "node:child_process";

export type Collector = "baseline" | "spans" | "cpu" | "timeline" | "memory";
type Browser = Parameters<typeof openRoomPage>[0];
type Page = Awaited<ReturnType<typeof openRoomPage>>["page"];
type CDPSession = Awaited<ReturnType<Browser["newBrowserCDPSession"]>>;
type CpuProfile = { profile: {
	nodes: Array<{ id: number; children?: number[]; callFrame: { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number } }>;
	samples?: number[];
	timeDeltas?: number[];
	startTime: number;
	endTime: number;
} };

export function bottomUp(profile: CpuProfile["profile"]) {
	const nodes = new Map(profile.nodes.map(node => [node.id, node]));
	const parents = new Map<number, number>();
	for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
	const rows = new Map<string, { name: string; selfMs: number; totalMs: number; samples: number; heaviestStack: string[]; stackMs: number }>();
	const stacks = new Map<string, number>();
	const key = (id: number) => {
		const frame = nodes.get(id)?.callFrame;
		return frame ? [frame.functionName || "(anonymous)", frame.url ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}` : ""].filter(Boolean).join(" ") : "(unknown)";
	};
	for (const [index, leaf] of (profile.samples ?? []).entries()) {
		const ms = (profile.timeDeltas?.[index] ?? 0) / 1000;
		const stack: string[] = [];
		for (let id: number | undefined = leaf; id !== undefined; id = parents.get(id)) stack.push(key(id));
		const stackKey = JSON.stringify(stack.slice().reverse());
		const stackMs = (stacks.get(stackKey) ?? 0) + ms;
		stacks.set(stackKey, stackMs);
		for (const name of new Set(stack)) {
			const row = rows.get(name) ?? { name, selfMs: 0, totalMs: 0, samples: 0, heaviestStack: [], stackMs: 0 };
			row.totalMs += ms;
			if (name === stack[0]) {
				row.selfMs += ms;
				row.samples++;
			}
			if (stackMs > row.stackMs) {
				row.stackMs = stackMs;
				row.heaviestStack = JSON.parse(stackKey);
			}
			rows.set(name, row);
		}
	}
	return [...rows.values()].sort((a, b) => b.selfMs - a.selfMs);
}

export function traceCpuTargets(trace: string) {
	type Profile = CpuProfile["profile"];
	type ChunkNode = Profile["nodes"][number] & { parent?: number };
	type Chunk = { name: string; pid: number; tid: number; id?: string; args?: { name?: string; data?: { cpuProfile?: { nodes?: ChunkNode[]; samples?: number[] }; timeDeltas?: number[] } } };
	const input = JSON.parse(trace) as { traceEvents: Chunk[] } | Chunk[];
	const events = Array.isArray(input) ? input : input.traceEvents;
	const threads = new Map<string, string>();
	const targets = new Map<string, { thread: string; nodes: Map<number, ChunkNode>; samples: number[]; timeDeltas: number[] }>();
	for (const event of events) if (event.name === "thread_name" && event.args?.name) threads.set(`${event.pid}:${event.tid}`, event.args.name);
	for (const event of events) {
		const data = event.args?.data;
		if (event.name !== "ProfileChunk" || !data?.cpuProfile) continue;
		const thread = `${event.pid}:${event.tid}`;
		const id = `${thread}:${event.id ?? "profile"}`;
		const profile = targets.get(id) ?? { thread, nodes: new Map<number, ChunkNode>(), samples: [] as number[], timeDeltas: [] as number[] };
		targets.set(id, profile);
		for (const node of data.cpuProfile.nodes ?? []) profile.nodes.set(node.id, node);
		profile.samples.push(...data.cpuProfile.samples ?? []);
		profile.timeDeltas.push(...data.timeDeltas ?? []);
	}
	return [...targets.values()].filter(target => target.samples.length > 0).map(target => {
		for (const node of target.nodes.values()) {
			const parent = node.parent === undefined ? undefined : target.nodes.get(node.parent);
			if (parent && !parent.children?.includes(node.id)) (parent.children ??= []).push(node.id);
		}
		const knownThread = [...target.nodes.values()].some(node => /\/canvasWorker[-.]/.test(node.callFrame.url ?? "")) ? "CanvasWorker" : threads.get(target.thread) ?? target.thread;
		return { thread: knownThread,
			rows: bottomUp({ nodes: [...target.nodes.values()], samples: target.samples, timeDeltas: target.timeDeltas, startTime: 0, endTime: 0 }) };
	});
}

function mapBrowserSources(rows: ReturnType<typeof bottomUp>, buildDir: string) {
	const maps = new Map<string, SourceMap>();
	const resolve = (frame: string) => {
		const location = frame.match(/^(.+) https?:\/\/[^/]+\/assets\/([\w.-]+\.js):(\d+):(\d+)$/);
		if (!location) return frame;
		const [, functionName, asset, line, column] = location;
		let map = maps.get(asset!);
		if (!map) {
			const source = path.join(buildDir, "assets", asset! + ".map");
			if (!existsSync(source)) return frame;
			map = new SourceMap(JSON.parse(readFileSync(source, "utf8")));
			maps.set(asset!, map);
		}
		const result = map.findEntry(Number(line) - 1, Number(column) - 1);
		if (!("originalSource" in result)) return frame;
		return `${result.name || functionName} ${result.originalSource}:${result.originalLine + 1}:${result.originalColumn + 1}`;
	};
	return rows.map(row => ({ ...row, name: resolve(row.name), heaviestStack: row.heaviestStack.map(resolve) }));
}

export async function collectBrowser(browser: Browser, pages: Page[], mode: Collector, dir: string, expectWorker: boolean) {
	const sessions: CDPSession[] = [];
	const cleanup: (() => Promise<unknown>)[] = [];
	const issues: string[] = [];
	const artifacts: string[] = [];
	const put = (name: string, value: unknown) => {
		writeFileSync(path.join(dir, name), JSON.stringify(value));
		artifacts.push(name);
	};
	const attach = async (page: Page, index: number) => {
		const session = await page.context().newCDPSession(page);
		sessions.push(session);
		if (mode === "memory") {
			const initial = await session.send("Runtime.getHeapUsage");
			cleanup.push(async () => {
				put(`page-${index}-memory.json`, { scope: "page isolate", initial, final: await session.send("Runtime.getHeapUsage") });
			});
		}
	};
	if (mode === "memory") {
		for (const [index, page] of pages.entries()) await attach(page, index);
	}
	if (mode === "timeline" || mode === "cpu") {
		const session = await browser.newBrowserCDPSession();
		sessions.push(session);
		const complete = new Promise<{ stream?: string; dataLossOccurred?: boolean }>(resolve => session.once("Tracing.tracingComplete", resolve));
		const events: unknown[] = [];
		let clipped = false;
		session.on("Tracing.dataCollected", result => {
			if (events.length + result.value.length > 120000) { clipped = true; return; }
			for (const event of result.value) events.push(event);
		});
		await session.send("Tracing.start", {
			transferMode: "ReportEvents",
			traceConfig: { recordMode: "recordContinuously", includedCategories: mode === "cpu" ?
				["disabled-by-default-v8.cpu_profiler"] :
				["devtools.timeline", "blink.user_timing", "toplevel", "cc", "v8", "loading"] },
		});
		const stopRecording = async () => {
			await session.send("Tracing.end");
			const result = await complete;
			if (result.dataLossOccurred || clipped) issues.push("Chromium trace buffer lost events");
			const filename = mode === "cpu" ? "chromium-cpu-trace.json" : "chromium-timeline.json";
			const trace = JSON.stringify({ traceEvents: events });
			writeFileSync(path.join(dir, filename), trace);
			artifacts.push(filename);
			if (mode === "cpu") {
				const targets = traceCpuTargets(trace);
				const buildDir = path.resolve(dir, "../../..", "build");
				targets.forEach((target, index) => put(`chromium-${index}-${target.thread.replace(/[^a-z0-9_-]/gi, "_")}-bottom-up.json`, mapBrowserSources(target.rows, buildDir)));
				if (expectWorker && !targets.some(target => /worker/i.test(target.thread))) issues.push("No Chromium Worker CPU target identified in this recording");
			}
		};
		let stopping: Promise<void> | undefined;
		const stopOnce = () => stopping ??= stopRecording().catch(error => { issues.push(String(error)); });
		const timer = setTimeout(() => void stopOnce(), 2500);
		cleanup.push(async () => { clearTimeout(timer); await stopOnce(); });
	}
	return async () => {
		for (const stop of cleanup) {
			try { await stop(); } catch (error) { issues.push(String(error)); }
		}
		await Promise.allSettled(sessions.map(session => session.detach()));
		return { artifacts, issues };
	};
}

export function collectGo(url: string | undefined, mode: Collector, dir: string) {
	if (!url || mode === "baseline" || mode === "spans") return async () => ({ artifacts: [], issues: [] });
	const target = mode === "cpu" ? "profile?seconds=5" : mode === "timeline" ? "trace?seconds=3" : "allocs?seconds=3";
	const file = mode === "timeline" ? "go.trace" : `go-${mode}.pprof`;
	const capture = (async () => {
		try {
			const response = await fetch(`${url}/${target}`, { signal: AbortSignal.timeout(15000) });
			if (!response.ok) throw new Error(`pprof HTTP ${response.status}`);
			const bytes = Buffer.from(await response.arrayBuffer());
			if (!bytes.length) throw new Error("Empty Go profile");
			writeFileSync(path.join(dir, file), bytes);
			const artifacts = [file];
			if (mode !== "timeline") {
				const output = execFileSync("go", ["tool", "pprof", "-top", "-nodecount=1000", path.join(dir, file)], { encoding: "utf8", timeout: 15000 });
				const name = `go-${mode}-top.txt`;
				writeFileSync(path.join(dir, name), output);
				artifacts.push(name);
			}
			return { artifacts, issues: [] };
		} catch (error) { return { artifacts: [], issues: [String(error)] }; }
	})();
	return () => capture;
}
