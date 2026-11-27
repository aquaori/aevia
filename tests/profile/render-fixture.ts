import { SceneEngine } from "../../apps/frontend/src/scene/sceneEngine";

const width = 1280, height = 720;
const canvas = document.createElement("canvas");
canvas.width = width;
canvas.height = height;
document.body.append(canvas);
const ctx = canvas.getContext("2d")!;
const rect = (x: number, y: number, w: number, h: number) => ({ minX: x, minY: y, maxX: x + w, maxY: y + h, width: w, height: h });

export function setup(count: number, tool: "pen" | "pencil" | "highlighter" = "pen") {
	const engine = new SceneEngine();
	const started = performance.now();
	for (let i = 0; i < count; i++) {
		const center = Math.floor(i / 50) % 4 === 0;
		engine.ingestFlatPoint({
			cmdId: `stroke-${Math.floor(i / 50)}`, pageId: 0, userId: "fixture", tool,
			color: "#111827", size: 3, isDeleted: false, pointIndex: i % 50, lamport: i + 1, p: 0.5,
			x: (center ? .08 : .35) + (i * 13 % 101) * .001, y: (center ? .08 : .35) + (i * 17 % 97) * .001,
		});
	}
	engine.finishAllOpenStrokes();
	const setupMs = performance.now() - started;
	engine.renderFull(ctx, width, height);
	const expected = ctx.getImageData(0, 0, width, height).data;
	return (mode: string) => {
		const start = performance.now();
		const result = mode === "direct" ? engine.renderFull(ctx, width, height) : engine.renderDirtyRegions(ctx, [
			mode === "dirty" ? rect(65, 25, 205, 135) : rect(0, 0, width, height),
		], width, height);
		const renderMs = performance.now() - start;
		const actual = ctx.getImageData(0, 0, width, height).data;
		const readbackMs = performance.now() - start - renderMs;
		const observed = typeof result === "number" ? "direct" : result.mode;
		let maxPremultipliedDiff = 0;
		let differentPixels = 0;
		for (let i = 0; i < actual.length; i += 4) {
			const actualAlpha = actual[i + 3]!, expectedAlpha = expected[i + 3]!;
			let difference = Math.abs(actualAlpha - expectedAlpha);
			for (let channel = 0; channel < 3; channel++) {
				difference = Math.max(difference, Math.abs(actual[i + channel]! * actualAlpha - expected[i + channel]! * expectedAlpha) / 255);
			}
			if (difference > 0) differentPixels++;
			maxPremultipliedDiff = Math.max(maxPremultipliedDiff, difference);
		}
		return {
			setupMs, renderMs, readbackMs, observed,
			samePixels: maxPremultipliedDiff === 0,
			maxPremultipliedDiff, differentPixels,
			...(typeof result === "number" ? { renderedAtoms: result } : result),
		};
	};
}
