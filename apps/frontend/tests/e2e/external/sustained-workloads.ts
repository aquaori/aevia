import type { Browser, Page } from "playwright";
import { v4 as uuidv4 } from "uuid";
import type { ExternalConfig } from "./types";
import {
	compareCanvasPages,
	installCanvasObserver,
	waitForStableCanvas,
} from "./canvas-observer";
import {
	createDistributedStrokePoints,
	joinRoom,
	ProtocolClient,
} from "./protocol-driver";
import {
	drawLine,
	openMeasuredRoomPage,
	pressRedo,
	pressUndo,
} from "./ui-driver";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const VALID_COLORS = ["#111827", "#2563eb", "#dc2626", "#059669", "#d97706"] as const;

/**
 * Seeds a heterogeneous whiteboard room containing pen, pencil, highlighter,
 * shapes, text, sticky notes, affine transforms, and partial erase masks so
 * late-join initialization benchmarks exercise every scene primitive and path.
 */
export async function seedRichScene(
	config: ExternalConfig,
	roomId: string,
	targetPoints = 12000
): Promise<{
	seededElements: number;
	seededPoints: number;
	transformedElements: number;
	erasedElements: number;
}> {
	const user = await joinRoom(config, roomId, "RichSceneSeed");
	const client = new ProtocolClient(config, user);
	await client.connect();
	let seededElements = 0;
	let seededPoints = 0;
	let transformedElements = 0;
	let erasedElements = 0;
	const createdStrokes: Array<{ elementId: string; points: Array<{ x: number; y: number; p: number }> }> = [];

	try {
		const pointsPerStroke = 48;
		const pathElementCount = Math.max(12, Math.floor(targetPoints / pointsPerStroke));
		const pathTools = ["pen", "pencil", "highlighter"] as const;

		for (let i = 0; i < pathElementCount; i += 1) {
			const tool = pathTools[i % pathTools.length]!;
			const points = createDistributedStrokePoints(pointsPerStroke, i, pathElementCount);
			const elementId = uuidv4();
			const style =
				tool === "highlighter"
					? { color: VALID_COLORS[i % VALID_COLORS.length]!, size: 14, strokePattern: "solid", opacity: 0.32 }
					: tool === "pencil"
						? { color: VALID_COLORS[i % VALID_COLORS.length]!, size: 3, strokePattern: "solid", opacity: 0.78 }
						: { color: VALID_COLORS[i % VALID_COLORS.length]!, size: 3, strokePattern: "solid" };

			await client.sendSceneOperation({
				elementId,
				kind: "element.create",
				waitForCommit: i % 16 === 15 || i === pathElementCount - 1,
				payload: {
					descriptor: { elementKind: "path", toolId: tool, recipeId: "stroke", style },
					points: points.map((pt, idx) => ({ ...pt, lamport: i * pointsPerStroke + idx + 1 })),
					isComplete: true,
				},
			});
			seededElements += 1;
			seededPoints += points.length;
			createdStrokes.push({ elementId, points });
		}

		// Mix shapes, text, and sticky elements across the viewport
		const shapeKinds = ["rectangle", "ellipse", "line"] as const;
		const shapeCount = 18;
		for (let i = 0; i < shapeCount; i += 1) {
			const kind = shapeKinds[i % shapeKinds.length]!;
			const x0 = 0.08 + ((i * 0.17) % 0.72);
			const y0 = 0.1 + ((Math.floor(i / 4) * 0.19) % 0.7);
			const elementId = uuidv4();
			await client.sendSceneOperation({
				elementId,
				kind: "element.create",
				waitForCommit: i === shapeCount - 1,
				payload: {
					descriptor: {
						elementKind: "shape",
						toolId: kind,
						recipeId: "shape",
						shapeKind: kind,
						style: { color: VALID_COLORS[(i + 1) % VALID_COLORS.length]!, size: 3 },
						start: { x: x0, y: y0 },
						end: { x: x0 + 0.11, y: y0 + 0.08 },
					},
				},
			});
			seededElements += 1;
		}

		for (let i = 0; i < 6; i += 1) {
			const isSticky = i % 2 === 1;
			const x0 = 0.1 + i * 0.13;
			const y0 = isSticky ? 0.62 : 0.18;
			const elementId = uuidv4();
			await client.sendSceneOperation({
				elementId,
				kind: "element.create",
				waitForCommit: i === 5,
				payload: {
					descriptor: {
						elementKind: isSticky ? "sticky" : "text",
						toolId: isSticky ? "sticky" : "text",
						recipeId: "glyph",
						style: isSticky
							? { color: "#1e293b", fillColor: "#fff7cc", fontSize: 18, size: 2 }
							: { color: "#0f172a", fontSize: 18, size: 2 },
						box: { minX: x0, minY: y0, maxX: x0 + 0.12, maxY: y0 + 0.08, width: 0.12, height: 0.08 },
						text: isSticky ? `便签#${i}` : `Text#${i}`,
					},
				},
			});
			seededElements += 1;
		}

		// Apply non-identity transforms (~15% of strokes) and partial erase masks (~8% of strokes)
		for (let i = 0; i < createdStrokes.length; i += 7) {
			const target = createdStrokes[i]!;
			await client.sendSceneOperation({
				elementId: target.elementId,
				historyGroupId: `xf-${i}`,
				kind: "element.transform",
				waitForCommit: i + 7 >= createdStrokes.length,
				payload: {
					targets: [{ elementId: target.elementId, deltaMatrix: [1, 0, 0, 1, 0.018, -0.012] }],
				},
			});
			transformedElements += 1;
		}

		for (let i = 2; i < createdStrokes.length; i += 12) {
			const target = createdStrokes[i]!;
			const mid = target.points[Math.floor(target.points.length / 2)]!;
			await client.sendSceneOperation({
				elementId: target.elementId,
				historyGroupId: `erase-${i}`,
				kind: "element.erase",
				waitForCommit: i + 12 >= createdStrokes.length,
				payload: {
					targets: [
						{
							elementId: target.elementId,
							intervals: [{ start: 10000, end: 22000 }],
							mask: {
								points: [
									{ x: mid.x - 0.015, y: mid.y - 0.015, p: 0.5, lamport: i + 1 },
									{ x: mid.x + 0.015, y: mid.y + 0.015, p: 0.5, lamport: i + 2 },
								],
								size: 10,
								width: 1280,
								height: 720,
								inverseMatrix: [1, 0, 0, 1, 0, 0],
							},
						},
					],
				},
			});
			erasedElements += 1;
		}
	} finally {
		client.close();
	}

	return { seededElements, seededPoints, transformedElements, erasedElements };
}

export async function runSustainedStrokeWorkload(options: {
	browser: Browser;
	config: ExternalConfig;
	roomId: string;
	pageA: Page;
	pageB?: Page;
	longPhaseMs?: number;
	shortPhaseStrokes?: number;
	viewport?: { width: number; height: number };
}) {
	const viewport = options.viewport ?? { width: 1280, height: 720 };
	const longPhaseMs = options.longPhaseMs ?? 6000;
	const shortPhaseStrokes = options.shortPhaseStrokes ?? 28;
	const sessions = await Promise.all(
		[options.pageA, ...(options.pageB ? [options.pageB] : [])].map((p) => p.context().newCDPSession(p))
	);
	const cdpA = sessions[0]!;
	const cdpB = sessions[1];

	let longPhaseMoves = 0;
	const phase1Start = performance.now();

	// Phase 1: continuous unbroken long stroke at ~90-120Hz (never releasing pointer)
	await cdpA.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 240, y: 200, button: "none", buttons: 0, clickCount: 0 });
	await cdpA.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 240, y: 200, button: "left", buttons: 1, clickCount: 1 });
	if (cdpB) {
		await cdpB.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 960, y: 500, button: "none", buttons: 0, clickCount: 0 });
		await cdpB.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 960, y: 500, button: "left", buttons: 1, clickCount: 1 });
	}

	let step = 0;
	while (performance.now() - phase1Start < longPhaseMs) {
		step += 1;
		const angle = step * 0.14;
		const ax = 640 + Math.cos(angle) * (160 + (step % 180));
		const ay = 360 + Math.sin(angle * 1.3) * (120 + (step % 110));
		const tasks: Array<Promise<unknown>> = [
			cdpA.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ax, y: ay, button: "none", buttons: 1, clickCount: 0 }),
		];
		if (cdpB) {
			const bx = 640 - Math.cos(angle * 0.9) * (150 + (step % 150));
			const by = 360 - Math.sin(angle * 1.1) * (110 + (step % 100));
			tasks.push(
				cdpB.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bx, y: by, button: "none", buttons: 1, clickCount: 0 })
			);
		}
		await Promise.all(tasks);
		longPhaseMoves += 1;
		await sleep(10);
	}
	await cdpA.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 640, y: 360, button: "left", buttons: 0, clickCount: 1 });
	if (cdpB) {
		await cdpB.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 640, y: 360, button: "left", buttons: 0, clickCount: 1 });
	}
	const phase1ElapsedMs = performance.now() - phase1Start;

	// Phase 2: high-frequency short distinct strokes (rapid element.create + cache invalidation)
	const phase2Start = performance.now();
	for (let i = 0; i < shortPhaseStrokes; i += 1) {
		const x = 180 + ((i * 89) % 880);
		const y = 120 + ((i * 67) % 440);
		await cdpA.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
		for (let s = 1; s <= 4; s += 1) {
			await cdpA.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + s * 14, y: y + s * 9, button: "none", buttons: 1, clickCount: 0 });
			await sleep(6);
		}
		await cdpA.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 56, y: y + 36, button: "left", buttons: 0, clickCount: 1 });
		if (cdpB && i % 2 === 0) {
			const bx = 220 + ((i * 73) % 820);
			const by = 140 + ((i * 53) % 420);
			await cdpB.send("Input.dispatchMouseEvent", { type: "mousePressed", x: bx, y: by, button: "left", buttons: 1, clickCount: 1 });
			await cdpB.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bx + 42, y: by - 24, button: "none", buttons: 1, clickCount: 0 });
			await cdpB.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: bx + 42, y: by - 24, button: "left", buttons: 0, clickCount: 1 });
		}
		await sleep(30);
	}
	const phase2ElapsedMs = performance.now() - phase2Start;
	await Promise.all(sessions.map((s) => s.detach().catch(() => undefined)));

	const fullRoi = { x: 0, y: 0, ...viewport };
	await installCanvasObserver(options.pageA);
	await waitForStableCanvas(options.pageA, { roi: fullRoi, timeoutMs: 10000, stableFrames: 8 });
	if (options.pageB) {
		await installCanvasObserver(options.pageB);
		await waitForStableCanvas(options.pageB, { roi: fullRoi, timeoutMs: 10000, stableFrames: 8 });
	}

	const refUser = await joinRoom(options.config, options.roomId, "SustainedRef");
	const refPage = await openMeasuredRoomPage(options.browser, { ...options.config, labEnabled: false }, refUser);
	let replayDifference: number;
	try {
		const deadlineAt = performance.now() + 8000;
		do {
			const res = await compareCanvasPages(options.pageA, refPage.page);
			replayDifference = res.diffRatio;
			if (replayDifference <= 0.015) break;
			await sleep(200);
		} while (performance.now() < deadlineAt);
	} finally {
		await refPage.close();
	}

	return {
		longPhaseElapsedMs: phase1ElapsedMs,
		longPhaseMoves,
		longPhaseInputRate: longPhaseMoves / Math.max(0.1, phase1ElapsedMs / 1000),
		shortPhaseElapsedMs: phase2ElapsedMs,
		shortPhaseStrokes,
		totalElapsedMs: phase1ElapsedMs + phase2ElapsedMs,
		replayDifference,
		converged: replayDifference <= 0.015,
	};
}

export async function runMultiToolCollabWorkload(options: {
	browser: Browser;
	config: ExternalConfig;
	roomId: string;
	pageA: Page;
	pageB: Page;
	viewport?: { width: number; height: number };
}) {
	const viewport = options.viewport ?? { width: 1280, height: 720 };
	const startedAt = performance.now();

	// Both clients draw overlapping strokes concurrently across tools
	const selectSubTool = async (page: Page, name: "铅笔" | "荧光笔" | "钢笔") => {
		const penButton = page.locator("button").filter({ has: page.locator("svg.lucide-pen-tool, svg.lucide-pencil, svg.lucide-highlighter") }).first();
		await penButton.click();
		await page.getByRole("button", { name, exact: true }).click();
	};

	// Step 1: pen vs pencil overlapping dense burst
	await Promise.all([
		(async () => {
			for (let i = 0; i < 6; i += 1) {
				await drawLine(options.pageA, 220 + i * 24, 160, 520 + i * 24, 340, 12);
			}
		})(),
		(async () => {
			await selectSubTool(options.pageB, "铅笔");
			for (let i = 0; i < 6; i += 1) {
				await drawLine(options.pageB, 520 - i * 24, 160, 220 + i * 24, 340, 12);
			}
		})(),
	]);

	// Step 2: highlighter vs rectangle concurrent
	await Promise.all([
		(async () => {
			await selectSubTool(options.pageA, "荧光笔");
			await drawLine(options.pageA, 220, 250, 620, 250, 16);
			await drawLine(options.pageA, 220, 300, 620, 300, 16);
		})(),
		(async () => {
			await options.pageB.locator('button[title="形状与内容"]').click();
			await options.pageB.getByRole("button", { name: "矩形", exact: true }).click();
			await drawLine(options.pageB, 680, 160, 860, 300, 10);
			await drawLine(options.pageB, 720, 340, 900, 460, 10);
		})(),
	]);

	// Step 3: partial erase + transform drag + text + sticky + undo/redo
	await Promise.all([
		(async () => {
			await options.pageA.locator("button").filter({ has: options.pageA.locator("svg.lucide-eraser") }).first().click();
			await drawLine(options.pageA, 280, 200, 440, 290, 8);
			await options.pageA.locator('button[title="形状与内容"]').click();
			await options.pageA.getByRole("button", { name: "文字", exact: true }).click();
			await drawLine(options.pageA, 160, 420, 400, 520, 8);
			const editor = options.pageA.getByRole("dialog", { name: "文字编辑器" });
			await editor.waitFor({ state: "visible" });
			await editor.locator("textarea").fill("Multi-Tool Collab Stress");
			await editor.getByRole("button", { name: "完成" }).click();
			await editor.waitFor({ state: "hidden" });
		})(),
		(async () => {
			await options.pageB.locator("button").filter({ has: options.pageB.locator("svg.lucide-mouse-pointer-2") }).first().click();
			await drawLine(options.pageB, 660, 140, 880, 320, 6);
			await drawLine(options.pageB, 760, 230, 810, 260, 6);
			await options.pageB.locator('button[title="形状与内容"]').click();
			await options.pageB.getByRole("button", { name: "便签", exact: true }).click();
			await drawLine(options.pageB, 480, 420, 680, 540, 8);
			const editor = options.pageB.getByRole("dialog", { name: "文字编辑器" });
			await editor.waitFor({ state: "visible" });
			await editor.locator("textarea").fill("便签协同压测");
			await editor.getByRole("button", { name: "完成" }).click();
			await editor.waitFor({ state: "hidden" });
		})(),
	]);

	await pressUndo(options.pageA);
	await pressRedo(options.pageA);

	const fullRoi = { x: 0, y: 0, ...viewport };
	await Promise.all([options.pageA, options.pageB].map(async (page) => {
		await installCanvasObserver(page);
		await waitForStableCanvas(page, { roi: fullRoi, timeoutMs: 10000, stableFrames: 8 });
	}));

	const refUser = await joinRoom(options.config, options.roomId, "CollabStressRef");
	const refPage = await openMeasuredRoomPage(options.browser, { ...options.config, labEnabled: false }, refUser);
	let interClientDiff: number;
	let replayDifference: number;
	try {
		const deadlineAt = performance.now() + 8000;
		do {
			const [ab, aRef] = await Promise.all([
				compareCanvasPages(options.pageA, options.pageB),
				compareCanvasPages(options.pageA, refPage.page),
			]);
			interClientDiff = ab.diffRatio;
			replayDifference = aRef.diffRatio;
			if (interClientDiff <= 0.015 && replayDifference <= 0.015) break;
			await sleep(200);
		} while (performance.now() < deadlineAt);
	} finally {
		await refPage.close();
	}

	return {
		totalElapsedMs: performance.now() - startedAt,
		interClientDiff,
		replayDifference,
		converged: interClientDiff <= 0.015 && replayDifference <= 0.015,
	};
}
