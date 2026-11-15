// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SceneOperationEnvelopeV2 } from "@collaborative-whiteboard/shared";
import { SceneCore } from "./sceneCore";
import { applyRenderIRDelta, diffRenderIR } from "./renderIR";

describe("SceneCore without browser rendering", () => {
	it("folds operations and queries geometry without a DOM or Canvas", () => {
		const core = new SceneCore();
		const create: SceneOperationEnvelopeV2 = {
			schemaVersion: 2, opId: "create", elementId: "stroke", actorId: "author", roomId: "room", pageId: 0, lamport: 1, historyGroupId: "create",
			kind: "element.create", payload: {
				descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#111", size: 4, strokePattern: "solid" } },
				points: [{ x: 0.1, y: 0.1, p: 0.5, lamport: 1 }, { x: 0.5, y: 0.5, p: 0.5, lamport: 2 }], isComplete: true,
			},
		};
		core.applyOperation(create);
		expect(core.exportFlatPoints()).toHaveLength(2);
		expect(core.queryElements({ minX: 0, minY: 0, maxX: 600, maxY: 600, width: 600, height: 600 }, 1000, 1000)).toContain("stroke");
		const initial = core.getRenderIR();
		core.applyOperation({
			...create, opId: "move", lamport: 3, historyGroupId: "move", kind: "element.transform",
			payload: { targets: [{ elementId: "stroke", deltaMatrix: [1, 0, 0, 1, 0.1, 0] }] },
		});
		const moved = core.getRenderIR();
		const delta = diffRenderIR(initial, moved);
		expect(applyRenderIRDelta(initial, delta)).toEqual(moved);
		expect(() => applyRenderIRDelta(moved, delta)).toThrow("revision mismatch");
		expect(initial.items[0]?.matrix).not.toEqual(moved.items[0]?.matrix);
	});
});
