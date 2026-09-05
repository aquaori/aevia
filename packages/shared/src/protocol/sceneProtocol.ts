// File role: deterministic ordering and validation for schema-v2 scene operations.
import {
	SCENE_SCHEMA_VERSION,
	type PrimitiveRecipeId,
	type RenderOrderKey,
	type SceneOperationEnvelopeV2,
} from "../types/scene";
import { compareCommandIds } from "./collabProtocol";

export const SUPPORTED_PRIMITIVE_RECIPES = new Set<PrimitiveRecipeId>([
	"stroke",
	"shape",
	"glyph",
	"bitmap",
]);

export const compareRenderOrder = (left: RenderOrderKey, right: RenderOrderKey): number => {
	if (left.lamport !== right.lamport) return left.lamport - right.lamport;
	const idOrder = compareCommandIds(left.opId, right.opId);
	if (idOrder !== 0) return idOrder;
	if (left.sourceIndex !== right.sourceIndex) return left.sourceIndex - right.sourceIndex;
	return left.subIndex - right.subIndex;
};

export const sceneOperationOrderKey = (
	operation: Pick<SceneOperationEnvelopeV2, "lamport" | "opId">,
	sourceIndex = 0,
	subIndex = 0
): RenderOrderKey => ({
	lamport: operation.lamport,
	opId: operation.opId,
	sourceIndex,
	subIndex,
});

export type SceneOperationValidationCode =
	| "UPGRADE_REQUIRED"
	| "INVALID_OPERATION"
	| "UNSUPPORTED_RECIPE";

export interface SceneOperationValidationResult {
	ok: boolean;
	code?: SceneOperationValidationCode;
	reason?: string;
}

const isFiniteInteger = (value: unknown) => Number.isInteger(value) && Number.isFinite(value);
const isFiniteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const isNonEmptyString = (value: unknown) => typeof value === "string" && value.length > 0;

export const validateSceneOperation = (value: unknown): SceneOperationValidationResult => {
	if (!value || typeof value !== "object") {
		return { ok: false, code: "INVALID_OPERATION", reason: "Operation must be an object." };
	}
	const operation = value as Partial<SceneOperationEnvelopeV2>;
	if (operation.schemaVersion !== SCENE_SCHEMA_VERSION) {
		return { ok: false, code: "UPGRADE_REQUIRED", reason: "Scene schema version 2 is required." };
	}
	if (
		!isNonEmptyString(operation.opId) ||
		!isNonEmptyString(operation.elementId) ||
		!isNonEmptyString(operation.actorId) ||
		!isNonEmptyString(operation.roomId) ||
		!isNonEmptyString(operation.historyGroupId) ||
		!isFiniteInteger(operation.pageId) ||
		(operation.pageId ?? -1) < 0 ||
		!isFiniteNumber(operation.lamport) ||
		!isNonEmptyString(operation.kind) ||
		!operation.payload ||
		typeof operation.payload !== "object"
	) {
		return { ok: false, code: "INVALID_OPERATION", reason: "Operation envelope is malformed." };
	}
	if (operation.kind === "element.create") {
		const recipeId = operation.payload.descriptor?.recipeId;
		if (!recipeId || !SUPPORTED_PRIMITIVE_RECIPES.has(recipeId)) {
			return { ok: false, code: "UNSUPPORTED_RECIPE", reason: "Primitive recipe is unsupported." };
		}
	}
	return { ok: true };
};
