import type { Browser, CDPSession, Page } from "playwright";
import type { BrowserPage, ExternalConfig, RoomUser } from "./types";
import { CANVAS_OBSERVER_INIT_SCRIPT, installCanvasObserver } from "./canvas-observer";
import { installPerformanceObserver } from "./performance-observer";
import { captureLabSnapshot, installLabRuntime, trackLabPage } from "./lab/install";

export const ROOM_RENDER_MEASUREMENT_SCRIPT = (config: {
	timeoutMs: number;
	minNonBlankRatio: number;
	sampleSize: number;
	stableFrames: number;
	quietWindowMs: number;
	waitForCollectionStop: boolean;
	maxDiffRatio: number;
}) => `
(() => {
	const measurementConfig = ${JSON.stringify(config)};
	window.__externalRenderCollectionStopped = false;
	window.__externalRoomRenderMeasurement = (async () => {
		const startedAt = performance.now();
		const timeoutAt = startedAt + measurementConfig.timeoutMs;
		const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
		while (performance.now() < timeoutAt) {
			if (
				window.__externalCanvasObserver &&
				document.querySelector("canvas")
			) {
				break;
			}
			await waitFrame();
		}
		if (!window.__externalCanvasObserver || !document.querySelector("canvas")) {
			throw new Error("room render measurement timeout: canvas observer unavailable");
		}
		const observer = window.__externalCanvasObserver;
		let firstNonBlankMs = null;
		let previous = observer.sample({ sampleSize: measurementConfig.sampleSize });
		let stableCount = 0;
		let stableSince = performance.now();
		let frames = 0;
		while (performance.now() < timeoutAt) {
			await waitFrame();
			frames += 1;
			const current = observer.sample({ sampleSize: measurementConfig.sampleSize });
			if (firstNonBlankMs === null && current.nonBlankRatio >= measurementConfig.minNonBlankRatio) {
				firstNonBlankMs = performance.now() - startedAt;
				stableSince = performance.now();
			}
			if (firstNonBlankMs !== null) {
				const diff = observer.diffRatio(previous.pixels, current.pixels, 8);
				if (diff <= measurementConfig.maxDiffRatio) {
					stableCount += 1;
					if (stableCount >= measurementConfig.stableFrames && performance.now() - stableSince >= measurementConfig.quietWindowMs && (!measurementConfig.waitForCollectionStop || window.__externalRenderCollectionStopped)) {
						return {
							firstNonBlankMs,
							visuallyStableMs: stableSince - startedAt,
							stabilityConfirmedMs: performance.now() - startedAt,
							frames,
							nonBlankRatio: current.nonBlankRatio,
						};
					}
				} else {
					stableCount = 0;
					stableSince = performance.now();
				}
			}
			previous = current;
		}
		throw new Error("room render measurement timeout: stable frame not reached");
	})();
})();
`;

const createRoomPage = async (browser: Browser, config: ExternalConfig) => {
	const launchContext = await browser.newContext({
		viewport: { width: 1280, height: 720 },
		recordVideo: undefined,
	});
	const page = await launchContext.newPage();
	if (config.labEnabled) {
		// Must be registered before the first navigation so the lab runtime exists
		// before any application script runs.
		await installLabRuntime(page);
		trackLabPage(page);
	}
	await installPerformanceObserver(page);

	let client: CDPSession | null = null;
	if (config.cpuThrottle > 1) {
		client = await launchContext.newCDPSession(page);
		await client.send("Emulation.setCPUThrottlingRate", { rate: config.cpuThrottle });
	}

	return {
		page,
		client,
		close: async () => {
			if (config.labEnabled) {
				await captureLabSnapshot(page).catch(() => undefined);
			}
			await client?.detach().catch(() => undefined);
			await launchContext.close();
		},
	};
};

export const openRoomPage = async (
	browser: Browser,
	config: ExternalConfig,
	user: RoomUser
): Promise<BrowserPage> => {
	const roomPage = await createRoomPage(browser, config);
	const { page } = roomPage;

	await page.goto(config.frontendUrl);
	await page.evaluate(({ token, userName, userId, expiresAt }: { token: string; userName: string; userId: string; expiresAt?: number | null }) => {
		sessionStorage.setItem("user", JSON.stringify({ token, sessionExpiresAt: expiresAt ?? null, userId, username: userName }));
		localStorage.setItem("wb_username", userName);
	}, { token: user.token, userName: user.userName, userId: user.userId, expiresAt: user.expiresAt ?? null });
	await page.goto(`${config.frontendUrl}/room`);
	await page.locator("canvas").first().waitFor({ timeout: 30000 });
	await installCanvasObserver(page);

	return {
		page,
		close: async () => {
			await roomPage.close();
		},
	};
};

export const openMeasuredRoomPage = async (
	browser: Browser,
	config: ExternalConfig,
	user: RoomUser
): Promise<BrowserPage & { initialRender: { firstNonBlankMs: number; visuallyStableMs: number; stabilityConfirmedMs: number; frames: number; nonBlankRatio: number } }> => {
	const roomPage = await createRoomPage(browser, config);
	const { page } = roomPage;

	await page.goto(config.frontendUrl);
	await page.evaluate(({ token, userName, userId, expiresAt }: { token: string; userName: string; userId: string; expiresAt?: number | null }) => {
		sessionStorage.setItem("user", JSON.stringify({ token, sessionExpiresAt: expiresAt ?? null, userId, username: userName }));
		localStorage.setItem("wb_username", userName);
	}, { token: user.token, userName: user.userName, userId: user.userId, expiresAt: user.expiresAt ?? null });
	await page.addInitScript({ content: CANVAS_OBSERVER_INIT_SCRIPT });
	await page.addInitScript({ content: ROOM_RENDER_MEASUREMENT_SCRIPT({
		timeoutMs: 60000,
		minNonBlankRatio: 0.0015,
		sampleSize: 96,
		stableFrames: 2,
		quietWindowMs: 500,
		waitForCollectionStop: config.labEnabled,
		maxDiffRatio: 0.0001,
	}) });
	await page.goto(`${config.frontendUrl}/room`);
	if (config.labEnabled) {
		await page.waitForFunction(() => {
			const marks = (window as unknown as { __AEVIA_LAB__?: { marks: { name: string; detail?: { reason?: string } }[] } }).__AEVIA_LAB__?.marks ?? [];
			return marks.some(mark => mark.name === "aevia.frame.first-paint") && marks.some(mark => mark.name === "aevia.frame.render-complete" && mark.detail?.reason === "init-stream-final");
		}, undefined, { timeout: config.caseTimeoutMs });
		await page.evaluate(() => { (window as unknown as { __externalRenderCollectionStopped: boolean }).__externalRenderCollectionStopped = true; });
	}
	const initialRender = await page.evaluate(
		() => (window as Window & { __externalRoomRenderMeasurement?: unknown }).__externalRoomRenderMeasurement
	);
	await page.locator("canvas").first().waitFor({ timeout: 30000 });
	await installCanvasObserver(page);

	return {
		page,
		initialRender,
		close: async () => {
			await roomPage.close();
		},
	};
};

export const drawLine = async (
	page: Page,
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	steps = 12
) => {
	const start = performance.now();
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(endX, endY, { steps });
	await page.mouse.up();
	return performance.now() - start;
};

export const drawLineLowLatency = async (
	page: Page,
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	steps = 2
) => {
	const client = await page.context().newCDPSession(page);
	const dispatch = async (
		type: "mouseMoved" | "mousePressed" | "mouseReleased",
		x: number,
		y: number,
		buttons = 0
	) =>
		client.send("Input.dispatchMouseEvent", {
			type,
			x,
			y,
			button: type === "mouseMoved" ? "none" : "left",
			buttons,
			clickCount: 1,
			pointerType: "mouse",
		});

	await dispatch("mouseMoved", startX, startY, 0);
	await dispatch("mousePressed", startX, startY, 1);
	for (let index = 1; index <= steps; index += 1) {
		const progress = index / steps;
		const x = startX + (endX - startX) * progress;
		const y = startY + (endY - startY) * progress;
		await dispatch("mouseMoved", x, y, 1);
	}
	await dispatch("mouseReleased", endX, endY, 0);
	await client.detach().catch(() => undefined);
};

export const pressUndo = async (page: Page) => {
	await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
	await page.keyboard.press("KeyZ");
	await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
};

export const pressRedo = async (page: Page) => {
	await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
	await page.keyboard.down("Shift");
	await page.keyboard.press("KeyZ");
	await page.keyboard.up("Shift");
	await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
};
