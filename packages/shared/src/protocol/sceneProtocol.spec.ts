import { describe, expect, it } from "vitest";
import { validateSceneOperation } from "./sceneProtocol";

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
});
