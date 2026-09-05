import { describe, expect, it } from "vitest";
import type { SceneOperationEnvelopeV2 } from "@collaborative-whiteboard/shared";
import { SceneEngine } from "../../src/scene/sceneEngine";

const WIDTH = 512;
const HEIGHT = 360;

const createCanvasContext = () => {
	const canvas = document.createElement("canvas");
	canvas.width = WIDTH;
	canvas.height = HEIGHT;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas2D is unavailable");
	return context;
};

const pixelRect = (bounds: NonNullable<ReturnType<SceneEngine["getElementBounds"]>>) => ({
	minX: bounds.minX * WIDTH,
	minY: bounds.minY * HEIGHT,
	maxX: bounds.maxX * WIDTH,
	maxY: bounds.maxY * HEIGHT,
	width: bounds.width * WIDTH,
	height: bounds.height * HEIGHT,
});

const operations: SceneOperationEnvelopeV2[] = [
	{
		schemaVersion: 2,
		opId: "background-shape",
		elementId: "background-shape",
		actorId: "browser-test",
		roomId: "room",
		pageId: 0,
		lamport: 1,
		historyGroupId: "background-shape",
		kind: "element.create",
		payload: {
			descriptor: {
				elementKind: "shape",
				toolId: "rounded-rectangle",
				recipeId: "shape",
				shapeKind: "rounded-rectangle",
				style: { color: "#1d4ed8", fillColor: "#dbeafe", size: 4 },
				box: { minX: 0.08, minY: 0.12, maxX: 0.72, maxY: 0.82, width: 0.64, height: 0.7 },
			},
		},
	},
	{
		schemaVersion: 2,
		opId: "foreground-stroke",
		elementId: "foreground-stroke",
		actorId: "browser-test",
		roomId: "room",
		pageId: 0,
		lamport: 2,
		historyGroupId: "foreground-stroke",
		kind: "element.create",
		payload: {
			descriptor: {
				elementKind: "path",
				toolId: "highlighter",
				recipeId: "stroke",
				style: { color: "#facc15", size: 22, opacity: 0.32, strokePattern: "dash-dot" },
			},
			points: [
				{ x: 0.12, y: 0.25, p: 0.5, lamport: 2 },
				{ x: 0.32, y: 0.55, p: 0.7, lamport: 3 },
				{ x: 0.62, y: 0.32, p: 0.6, lamport: 4 },
			],
			isComplete: true,
		},
	},
];

const transform: SceneOperationEnvelopeV2 = {
	schemaVersion: 2,
	opId: "move-background",
	elementId: "background-shape",
	actorId: "browser-test",
	roomId: "room",
	pageId: 0,
	lamport: 5,
	historyGroupId: "move-background",
	kind: "element.transform",
	payload: {
		targets: [{ elementId: "background-shape", deltaMatrix: [1, 0, 0, 1, 0.18, -0.05] }],
	},
};

describe("SceneEngine dirty rendering", () => {
	it("is pixel-identical to a full redraw after a transform", () => {
		const dirtyEngine = new SceneEngine();
		const fullEngine = new SceneEngine();
		for (const operation of operations) {
			dirtyEngine.applyOperation(operation);
			fullEngine.applyOperation(operation);
		}
		const dirtyContext = createCanvasContext();
		const fullContext = createCanvasContext();
		dirtyEngine.renderFull(dirtyContext, WIDTH, HEIGHT);
		fullEngine.renderFull(fullContext, WIDTH, HEIGHT);

		const oldBounds = dirtyEngine.getElementBounds("background-shape");
		dirtyEngine.applyOperation(transform);
		fullEngine.applyOperation(transform);
		const newBounds = dirtyEngine.getElementBounds("background-shape");
		if (!oldBounds || !newBounds) throw new Error("Expected transform bounds");

		dirtyEngine.renderDirtyRegions(
			dirtyContext,
			[pixelRect(oldBounds), pixelRect(newBounds)],
			WIDTH,
			HEIGHT
		);
		fullEngine.renderFull(fullContext, WIDTH, HEIGHT);

		const dirtyPixels = dirtyContext.getImageData(0, 0, WIDTH, HEIGHT).data;
		const fullPixels = fullContext.getImageData(0, 0, WIDTH, HEIGHT).data;
		let different = 0;
		for (let index = 0; index < dirtyPixels.length; index += 1) {
			if (dirtyPixels[index] !== fullPixels[index]) different += 1;
		}
		expect(different).toBe(0);
	});
});
