import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import type { Command } from "@collaborative-whiteboard/shared";
import { cloneCommandForStateSync } from "./renderWorkerBridge";

const command = (points: Command["points"]): Command => ({
	id: "cmd-1",
	type: "path",
	tool: "pen",
	color: "#000000",
	size: 4,
	points,
	timestamp: 1,
	userId: "user-1",
	roomId: "room-1",
	pageId: 0,
	isDeleted: false,
	lamport: 1,
	box: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 },
});

describe("cloneCommandForStateSync", () => {
	it("preserves omitted points so metadata updates do not erase worker geometry", () => {
		const cloned = cloneCommandForStateSync(command(undefined));

		expect(cloned.points).toBeUndefined();
	});

	it("deep-clones points when geometry replacement is intentional", () => {
		const source = command([{ x: 0.1, y: 0.2, p: 0.5, lamport: 1 }]);
		const cloned = cloneCommandForStateSync(source);

		expect(cloned.points).toEqual(source.points);
		expect(cloned.points).not.toBe(source.points);
	});

	it("removes Vue proxies from nested scene operations before posting to the worker", () => {
		const source = reactive({
			...command(undefined),
			id: "transform-1",
			type: "scene-op" as const,
			schemaVersion: 2 as const,
			sceneOperation: {
				schemaVersion: 2 as const,
				opId: "transform-1",
				elementId: "stroke-1",
				actorId: "user-1",
				roomId: "room-1",
				pageId: 0,
				lamport: 2,
				historyGroupId: "transform-1",
				kind: "element.transform" as const,
				payload: { targets: [{ elementId: "stroke-1", deltaMatrix: [1, 0, 0, 1, 0.1, 0.2] as const }] },
			},
		});

		const cloned = cloneCommandForStateSync(source);
		expect(() => structuredClone(cloned)).not.toThrow();
		expect(cloned.sceneOperation).not.toBe(source.sceneOperation);
	});
});
