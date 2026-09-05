import { bench, describe } from "vitest";
import type { FlatPoint } from "@collaborative-whiteboard/shared";
import { SceneEngine } from "../../src/scene/sceneEngine";

const VIEWPORT = 1000;
const DIRTY_RECT = { minX: 8, minY: 8, maxX: 32, maxY: 32, width: 24, height: 24 };

const point = (cmdId: string, index: number, x: number, y: number): FlatPoint => ({
	x,
	y,
	p: 0.55,
	lamport: index + 1,
	cmdId,
	pageId: 0,
	userId: "bench",
	tool: "pen",
	color: "#111827",
	size: 3,
	isDeleted: false,
	pointIndex: index,
});

const buildEngine = (count: number, mode: "sparse" | "full-page" | "hotspot") => {
	const engine = new SceneEngine();
	engine.ingestFlatPoint(point("near", 0, 0.012, 0.012));
	engine.ingestFlatPoint(point("near", 1, 0.022, 0.022));
	for (let index = 0; index < count; index += 1) {
		let x: number;
		let y: number;
		if (mode === "sparse") {
			x = 0.55 + (index % 400) / 1000;
			y = 0.55 + (Math.floor(index / 400) % 400) / 1000;
		} else if (mode === "hotspot") {
			x = 0.01 + (index % 80) / 10000;
			y = 0.01 + (Math.floor(index / 80) % 80) / 10000;
		} else {
			x = (index % 1000) / 999;
			y = (Math.floor(index / 1000) % 100) / 99;
		}
		engine.ingestFlatPoint(point(mode, index, x, y));
	}
	engine.finishAllOpenStrokes();
	return engine;
};

describe("dirty-replay query and order recovery", () => {
	let sparse10k: SceneEngine | undefined;
	let sparse100k: SceneEngine | undefined;
	let longStroke100k: SceneEngine | undefined;
	let hotspot100k: SceneEngine | undefined;

	bench("sparse-10k-fixed-small-region", () => {
		(sparse10k ??= buildEngine(10_000, "sparse")).queryDirtyCandidates(
			DIRTY_RECT,
			VIEWPORT,
			VIEWPORT
		);
	});

	bench("sparse-100k-fixed-small-region", () => {
		(sparse100k ??= buildEngine(100_000, "sparse")).queryDirtyCandidates(
			DIRTY_RECT,
			VIEWPORT,
			VIEWPORT
		);
	});

	bench("single-full-page-stroke-100k", () => {
		(longStroke100k ??= buildEngine(100_000, "full-page")).queryDirtyCandidates(
			DIRTY_RECT,
			VIEWPORT,
			VIEWPORT
		);
	});

	bench("dense-hotspot-100k", () => {
		(hotspot100k ??= buildEngine(100_000, "hotspot")).queryDirtyCandidates(
			DIRTY_RECT,
			VIEWPORT,
			VIEWPORT
		);
	});
});
