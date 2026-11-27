import { bench, describe } from "vitest";
import { getCommandBoundingBox } from "../../src/utils/geometry";
import { encodeCmdUpdateBinary, decodeRealtimeBinaryMessage } from "../../src/service/realtimeBinary";
import { SceneCore } from "../../src/scene/sceneCore";
import { diffRenderIR } from "../../src/scene/renderIR";
import { decodeRenderIR, encodeRenderIR } from "../../src/scene/renderIRCodec";
import { SCENE_SCHEMA_VERSION, type Command, type SceneOperationEnvelopeV2 } from "@collaborative-whiteboard/shared";

const points = Array.from({ length: 512 }, (_, index) => ({
	x: (index % 128) / 128,
	y: Math.floor(index / 128) / 4,
	p: 0.5,
	lamport: index,
}));

const command: Command = {
	id: "bench-command",
	type: "path",
	tool: "pen",
	color: "#111111",
	size: 4,
	points,
	timestamp: 0,
	userId: "bench-user",
	roomId: "bench-room",
	pageId: 0,
	isDeleted: false,
	lamport: 1,
	box: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 },
};

const encoded = encodeCmdUpdateBinary({ cmdId: command.id, points });

const makeStrokeOp = (index: number, kind: "element.create" | "element.append" | "history.toggle", targetGroup?: string): SceneOperationEnvelopeV2 => {
	const opId = `op-${String(index).padStart(6, "0")}`;
	if (kind === "element.create") {
		return {
			schemaVersion: SCENE_SCHEMA_VERSION,
			opId,
			elementId: `el-${index}`,
			actorId: "bench-user",
			roomId: "bench-room",
			pageId: 0,
			lamport: index + 1,
			historyGroupId: `grp-${Math.floor(index / 4)}`,
			kind: "element.create",
			payload: {
				descriptor: { elementKind: "path", toolId: "pen", recipeId: "stroke", style: { color: "#111827", size: 3, strokePattern: "solid" } },
				points: points.slice(0, 16),
				isComplete: false,
			},
		};
	}
	if (kind === "history.toggle") {
		return {
			schemaVersion: SCENE_SCHEMA_VERSION,
			opId,
			elementId: "el-0",
			actorId: "bench-user",
			roomId: "bench-room",
			pageId: 0,
			lamport: index + 1,
			historyGroupId: opId,
			kind: "history.toggle",
			payload: { targetHistoryGroupId: targetGroup ?? "grp-0", enabled: index % 2 === 1 },
		};
	}
	return {
		schemaVersion: SCENE_SCHEMA_VERSION,
		opId,
		elementId: "el-0",
		actorId: "bench-user",
		roomId: "bench-room",
		pageId: 0,
		lamport: index + 1,
		historyGroupId: "grp-0",
		kind: "element.append",
		payload: { sourceStart: 16 + (index - 1) * 4, points: points.slice(0, 4), isComplete: false },
	};
};

const irCore = new SceneCore();
for (let i = 0; i < 64; i += 1) irCore.applyOperation(makeStrokeOp(i, "element.create"));
const irFrameA = irCore.getRenderIR();
irCore.applyOperation(makeStrokeOp(64, "element.create"));
const irFrameB = irCore.getRenderIR();
const encodedIR = encodeRenderIR(irFrameA);

describe("render core micro benchmarks", () => {
	bench("geometry bounding box", () => {
		getCommandBoundingBox(command, command.size);
	});

	bench("binary command encode", () => {
		encodeCmdUpdateBinary({ cmdId: command.id, points });
	});

	bench("binary command decode", () => {
		decodeRealtimeBinaryMessage(encoded);
	});

	bench("SceneCore tail append 64 ops", () => {
		const core = new SceneCore();
		core.applyOperation(makeStrokeOp(0, "element.create"));
		for (let i = 1; i <= 64; i += 1) core.applyOperation(makeStrokeOp(i, "element.append"));
	});

	bench("SceneCore history toggle on 64 elements", () => {
		const core = new SceneCore();
		for (let i = 0; i < 64; i += 1) core.applyOperation(makeStrokeOp(i, "element.create"));
		core.applyOperation(makeStrokeOp(100, "history.toggle", "grp-0"));
		core.applyOperation(makeStrokeOp(101, "history.toggle", "grp-0"));
	});

	bench("RenderIR encode frame (64 items)", () => {
		encodeRenderIR(irFrameA);
	});

	bench("RenderIR decode frame (64 items)", () => {
		decodeRenderIR(encodedIR);
	});

	bench("RenderIR diff frames (64 items)", () => {
		diffRenderIR(irFrameA, irFrameB);
	});

	bench("SceneCore history toggle checkpoint (512 ops vs cold rebuild)", () => {
		const core = new SceneCore();
		for (let i = 0; i < 256; i += 1) {
			core.applyOperation(makeStrokeOp(i, i === 0 ? "element.create" : "element.append"));
		}
		// Trigger 1st checkpoint on grp-0, then toggle latest group at tail.
		core.applyOperation(makeStrokeOp(256, "element.create", "grp-tail"));
		core.applyOperation(makeStrokeOp(257, "history.toggle", "grp-64"));
		core.applyOperation(makeStrokeOp(258, "history.toggle", "grp-64"));
	});
});
