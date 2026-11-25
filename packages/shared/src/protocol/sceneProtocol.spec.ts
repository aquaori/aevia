import { describe, expect, it } from "vitest";
import { compareRenderOrder, sceneOperationOrderKey, validateSceneOperation } from "./sceneProtocol";
import type { SceneOperationEnvelopeV2 } from "../types/scene";

const validCreate = () => ({
	schemaVersion: 2,
	opId: "op-1",
	elementId: "el-1",
	actorId: "u1",
	roomId: "r1",
	historyGroupId: "hg-1",
	pageId: 0,
	lamport: 1,
	kind: "element.create",
	payload: {
		descriptor: {
			elementKind: "path",
			recipeId: "stroke",
			style: { color: "#000", size: 2 },
		},
		points: [{ x: 1, y: 2 }],
	},
});

describe("validateSceneOperation", () => {
	it("rejects non-object and wrong schema version", () => {
		expect(validateSceneOperation(null)).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
		expect(validateSceneOperation("str")).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
		expect(validateSceneOperation({ schemaVersion: 1 })).toMatchObject({ ok: false, code: "UPGRADE_REQUIRED" });
	});

	it("rejects malformed envelopes across required fields", () => {
		const badOpId = { ...validCreate(), opId: "bad space!" };
		expect(validateSceneOperation(badOpId)).toMatchObject({ ok: false, code: "INVALID_OPERATION" });

		const badCreateId = { ...validCreate(), elementId: "bad space!" };
		expect(validateSceneOperation(badCreateId)).toMatchObject({ ok: false, code: "INVALID_OPERATION" });

		const badPage = { ...validCreate(), pageId: -1 };
		expect(validateSceneOperation(badPage)).toMatchObject({ ok: false, code: "INVALID_OPERATION" });

		const badLamport = { ...validCreate(), lamport: Number.NaN };
		expect(validateSceneOperation(badLamport)).toMatchObject({ ok: false, code: "INVALID_OPERATION" });

		const badPayload = { ...validCreate(), payload: null };
		expect(validateSceneOperation(badPayload)).toMatchObject({ ok: false, code: "INVALID_OPERATION" });
	});

	it("validates recipeId on element.create and allows non-create kinds", () => {
		const unsupported = validCreate();
		unsupported.payload.descriptor.recipeId = "unknown-recipe";
		expect(validateSceneOperation(unsupported)).toMatchObject({ ok: false, code: "UNSUPPORTED_RECIPE" });

		expect(validateSceneOperation(validCreate())).toEqual({ ok: true });

		expect(
			validateSceneOperation({
				...validCreate(),
				kind: "element.append",
				elementId: "any-existing-id!",
				payload: { sourceStart: 1, points: [{ x: 2, y: 3 }] },
			}),
		).toEqual({ ok: true });
	});

	it("validates and orders golden fixtures for all 9 V2 scene operation kinds", () => {
		const base = {
			schemaVersion: 2 as const,
			actorId: "actor-1",
			roomId: "room-golden",
			pageId: 0,
			historyGroupId: "hg-golden",
		};
		const goldenOps: SceneOperationEnvelopeV2[] = [
			{
				...base,
				opId: "op-01-create",
				elementId: "el-path-1",
				lamport: 1,
				kind: "element.create",
				payload: {
					descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#111111", size: 4 } },
					points: [{ x: 0.1, y: 0.1, p: 0.5, lamport: 1 }],
				},
			},
			{
				...base,
				opId: "op-02-append",
				elementId: "el-path-1",
				lamport: 2,
				kind: "element.append",
				payload: {
					sourceStart: 1,
					points: [{ x: 0.2, y: 0.2, p: 0.5, lamport: 2 }],
					isComplete: true,
				},
			},
			{
				...base,
				opId: "op-03-transform",
				elementId: "el-path-1",
				lamport: 3,
				kind: "element.transform",
				payload: {
					targets: [{ elementId: "el-path-1", deltaMatrix: [1, 0, 0, 1, 0.05, 0.05] }],
				},
			},
			{
				...base,
				opId: "op-04-style",
				elementId: "el-path-1",
				lamport: 4,
				kind: "element.style",
				payload: {
					style: { color: "#2563eb", size: 6 },
				},
			},
			{
				...base,
				opId: "op-05-erase",
				elementId: "el-path-1",
				lamport: 5,
				kind: "element.erase",
				payload: {
					targets: [{ elementId: "el-path-1", intervals: [{ start: 0, end: 1 }] }],
				},
			},
			{
				...base,
				opId: "op-06-text",
				elementId: "el-text-1",
				lamport: 6,
				kind: "text.patch",
				payload: {
					patches: [{ type: "insert", charId: "c1", afterId: null, grapheme: "A" }],
				},
			},
			{
				...base,
				opId: "op-07-delete",
				elementId: "el-path-1",
				lamport: 7,
				kind: "element.delete",
				payload: {
					elementIds: ["el-path-1"],
				},
			},
			{
				...base,
				opId: "op-08-toggle",
				elementId: "el-path-1",
				lamport: 8,
				kind: "history.toggle",
				payload: {
					targetHistoryGroupId: "hg-golden",
					enabled: false,
				},
			},
			{
				...base,
				opId: "op-09-clear",
				elementId: "page-0",
				lamport: 9,
				kind: "page.clear",
				payload: {
					before: { lamport: 9, opId: "op-09-clear", sourceIndex: 0, subIndex: 0 },
				},
			},
		];

		expect(new Set(goldenOps.map((op) => op.kind)).size).toBe(9);
		for (const op of goldenOps) {
			expect(validateSceneOperation(op)).toEqual({ ok: true });
		}

		const reversed = [...goldenOps].reverse();
		reversed.sort((a, b) => compareRenderOrder(sceneOperationOrderKey(a), sceneOperationOrderKey(b)));
		expect(reversed.map((op) => op.opId)).toEqual(goldenOps.map((op) => op.opId));
	});
});
