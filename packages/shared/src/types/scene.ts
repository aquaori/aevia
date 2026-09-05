// File role: canonical immutable scene-operation and render ordering contracts.
import type { AabbBox, Point } from "./collab";

export const SCENE_SCHEMA_VERSION = 2 as const;

export type SceneOperationKind =
	| "element.create"
	| "element.append"
	| "element.transform"
	| "element.style"
	| "element.erase"
	| "element.delete"
	| "text.patch"
	| "history.toggle"
	| "page.clear";

export type PrimitiveRecipeId = "stroke" | "shape" | "glyph" | "bitmap";
export type ElementKind = "path" | "shape" | "text" | "sticky" | "sticker";
export type StrokePattern = "solid" | "dashed" | "dotted" | "dash-dot" | "double";
export type ShapeKind = "line" | "arrow" | "rectangle" | "rounded-rectangle" | "ellipse";
export type EditorTool =
	| "cursor"
	| "pen"
	| "pencil"
	| "highlighter"
	| "eraser"
	| "object-eraser"
	| ShapeKind
	| "text"
	| "sticky"
	| "sticker";

export interface RenderOrderKey {
	lamport: number;
	opId: string;
	sourceIndex: number;
	subIndex: number;
}

export type AffineMatrix = readonly [number, number, number, number, number, number];

export interface SceneElementStyle {
	color: string;
	fillColor?: string;
	size: number;
	opacity?: number;
	strokePattern?: StrokePattern;
	fontFamily?: string;
	fontSize?: number;
	fontWeight?: 400 | 700;
	textAlign?: "left" | "center" | "right";
}

export interface SceneElementDescriptor {
	elementKind: ElementKind;
	toolId: string;
	recipeId: PrimitiveRecipeId;
	style: SceneElementStyle;
	shapeKind?: ShapeKind;
	shapeStart?: { x: number; y: number };
	shapeEnd?: { x: number; y: number };
	box?: AabbBox;
	text?: string;
	sticker?: string;
}

export interface ElementCreatePayload {
	descriptor: SceneElementDescriptor;
	points?: Point[];
	isComplete?: boolean;
}

export interface ElementAppendPayload {
	points: Point[];
	sourceStart: number;
	isComplete?: boolean;
}

export interface TransformTarget {
	elementId: string;
	deltaMatrix: AffineMatrix;
	pivot?: { x: number; y: number };
}

export interface ElementTransformPayload {
	targets: TransformTarget[];
}

export interface ElementStylePayload {
	style: Partial<SceneElementStyle>;
}

export interface QuantizedInterval {
	start: number;
	end: number;
}

export interface EraseTarget {
	elementId: string;
	atomId?: string;
	intervals?: QuantizedInterval[];
	eraseWhole?: boolean;
}

export interface ElementErasePayload {
	targets: EraseTarget[];
}

export interface ElementDeletePayload {
	elementIds: string[];
}

export interface TextInsertPatch {
	type: "insert";
	charId: string;
	afterId: string | null;
	grapheme: string;
}

export interface TextDeletePatch {
	type: "delete";
	charId: string;
}

export type TextPatch = TextInsertPatch | TextDeletePatch;

export interface TextPatchPayload {
	patches: TextPatch[];
}

export interface HistoryTogglePayload {
	targetHistoryGroupId: string;
	enabled: boolean;
}

export interface PageClearPayload {
	before: RenderOrderKey;
}

interface SceneOperationBase {
	schemaVersion: typeof SCENE_SCHEMA_VERSION;
	opId: string;
	elementId: string;
	actorId: string;
	roomId: string;
	pageId: number;
	lamport: number;
	historyGroupId: string;
}

export type SceneOperationEnvelopeV2 =
	| (SceneOperationBase & { kind: "element.create"; payload: ElementCreatePayload })
	| (SceneOperationBase & { kind: "element.append"; payload: ElementAppendPayload })
	| (SceneOperationBase & { kind: "element.transform"; payload: ElementTransformPayload })
	| (SceneOperationBase & { kind: "element.style"; payload: ElementStylePayload })
	| (SceneOperationBase & { kind: "element.erase"; payload: ElementErasePayload })
	| (SceneOperationBase & { kind: "element.delete"; payload: ElementDeletePayload })
	| (SceneOperationBase & { kind: "text.patch"; payload: TextPatchPayload })
	| (SceneOperationBase & { kind: "history.toggle"; payload: HistoryTogglePayload })
	| (SceneOperationBase & { kind: "page.clear"; payload: PageClearPayload });

export const IDENTITY_MATRIX: AffineMatrix = [1, 0, 0, 1, 0, 0];
