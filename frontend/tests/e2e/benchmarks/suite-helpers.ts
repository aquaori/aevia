import fs from "fs";
import path from "path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type {
	BenchmarkEnvironmentId,
	BenchmarkRunMode,
	DatasetShape,
} from "./core-types";
import { CONFIG, createRoom, joinRoom } from "./utils";
import { ensureDir } from "./core-utils";

const createContextAndPage = async (
	browser: Browser,
	throttleCpu: boolean,
	viewport = { width: 1280, height: 720 }
) => {
	const context = await browser.newContext({ viewport });
	const page = await context.newPage();
	let client: CDPSession | null = null;
	if (throttleCpu) {
		client = await context.newCDPSession(page);
		await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
	}
	return { context, page, client };
};

const bootstrapRoomPage = async (
	page: Page,
	credentials: { token: string; userName: string },
	roomPath = "/room"
) => {
	await page.goto(CONFIG.FRONTEND_URL);
	await page.evaluate(({ t, name }: { t: string; name: string }) => {
		sessionStorage.setItem("user", JSON.stringify({ token: t, userId: "", username: name }));
		localStorage.setItem("wb_username", name);
	}, { t: credentials.token, name: credentials.userName });
	await page.goto(`${CONFIG.FRONTEND_URL}${roomPath}`);
	await page.waitForSelector("canvas", { timeout: 30000 });
	await page.waitForTimeout(1000);
};

const readBenchmarkRuntime = async (page: Page) =>
	page.evaluate(() => {
		const runtime = (window as any).__benchmarkRuntime || {};
		const commands = (window as any).__benchmarkCommands?.value || [];
		return {
			...runtime,
			commandCount: runtime.commandCount ?? commands.length,
			lastCommandDigest:
				runtime.lastCommandDigest ||
				commands
					.map((command: any) => command.id)
					.join(",")
					.substring(0, 200),
		};
	});

const sampleHeap = async (page: Page) =>
	page.evaluate(() => {
		const runtime = (window as any).__benchmarkRuntime;
		if (runtime && typeof runtime === "object") {
			const memory = (window.performance as any).memory;
			if (!memory) return runtime.heap || null;
			const usedMb = memory.usedJSHeapSize / (1024 * 1024);
			runtime.heap = runtime.heap || { samples: [] };
			runtime.heap.lastUsedMb = usedMb;
			runtime.heap.endUsedMb = usedMb;
			runtime.heap.peakUsedMb = Math.max(runtime.heap.peakUsedMb || 0, usedMb);
			runtime.heap.samples = [...(runtime.heap.samples || []), { ts: performance.now(), usedMb }];
			return runtime.heap;
		}
		return null;
	});

const getCanvasDataUrls = async (page: Page) =>
	page.evaluate(() => {
		const canvases = Array.from(document.querySelectorAll("canvas"));
		return canvases.map((canvas) => (canvas as HTMLCanvasElement).toDataURL("image/png"));
	});

const writeDataUrlPng = (dataUrl: string, destPath: string) => {
	ensureDir(path.dirname(destPath));
	const buffer = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
	fs.writeFileSync(destPath, buffer);
};

const compareCanvasDataUrls = (
	a: string,
	b: string,
	diffPath?: string
): { diffPixels: number; diffRatio: number; passThreshold: number } => {
	const imgA = PNG.sync.read(Buffer.from(a.replace(/^data:image\/png;base64,/, ""), "base64"));
	const imgB = PNG.sync.read(Buffer.from(b.replace(/^data:image\/png;base64,/, ""), "base64"));
	if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
		return { diffPixels: Number.MAX_SAFE_INTEGER, diffRatio: 1, passThreshold: 0.005 };
	}
	const diff = new PNG({ width: imgA.width, height: imgA.height });
	const diffPixels = pixelmatch(imgA.data, imgB.data, diff.data, imgA.width, imgA.height, {
		threshold: 0.1,
	});
	if (diffPath) {
		ensureDir(path.dirname(diffPath));
		fs.writeFileSync(diffPath, PNG.sync.write(diff));
	}
	return {
		diffPixels,
		diffRatio: diffPixels / (imgA.width * imgA.height),
		passThreshold: 0.005,
	};
};

const getEnvironmentMatrix = (
	runMode: BenchmarkRunMode
): Array<{
	id: BenchmarkEnvironmentId;
	headless: boolean;
	throttleCpu: boolean;
	gpuEnabled: boolean;
}> => {
	const headless = runMode === "headless";
	return [
		{ id: "gpu_cpuHigh", headless, throttleCpu: false, gpuEnabled: true },
		{ id: "gpu_cpuLow", headless, throttleCpu: true, gpuEnabled: true },
		{ id: "noGpu_cpuHigh", headless, throttleCpu: false, gpuEnabled: false },
		{ id: "noGpu_cpuLow", headless, throttleCpu: true, gpuEnabled: false },
	];
};

const matchesShape = (shape: DatasetShape, metric: string) => `${shape}:${metric}`;

const createRoomWithUsers = async (name: string, userNames: string[]) => {
	const roomId = String(Math.floor(100000 + Math.random() * 900000));
	await createRoom(roomId, name);
	const creds = [];
	for (const userName of userNames) {
		const cred = await joinRoom(roomId, userName);
		if (!cred) throw new Error(`failed to join room for ${userName}`);
		creds.push(cred);
	}
	return { roomId, creds };
};

const digestCommands = (commands: Array<{ id: string; type?: string; pageId?: number }>) =>
	commands
		.map((command) => `${command.id}:${command.type || "na"}:${command.pageId ?? 0}`)
		.join("|")
		.substring(0, 400);

export {
	bootstrapRoomPage,
	compareCanvasDataUrls,
	createContextAndPage,
	createRoomWithUsers,
	digestCommands,
	getCanvasDataUrls,
	getEnvironmentMatrix,
	matchesShape,
	readBenchmarkRuntime,
	sampleHeap,
	writeDataUrlPng,
};
