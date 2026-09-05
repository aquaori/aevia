// File role: renderer-internal scene primitives shared by worker and fallback paths.
import type {
	AabbBox,
	AffineMatrix,
	Point,
	PrimitiveRecipeId,
	RenderOrderKey,
	SceneElementDescriptor,
	SceneElementStyle,
} from "@collaborative-whiteboard/shared";

export type SceneRect = AabbBox;

export interface RenderAtomBase {
	ref: number;
	atomId: string;
	elementId: string;
	elementRevision: number;
	pageId: number;
	order: RenderOrderKey;
	recipeId: PrimitiveRecipeId;
	toolId: string;
	style: SceneElementStyle;
	bounds: AabbBox;
}

export interface DotAtom extends RenderAtomBase {
	recipeId: "stroke";
	primitive: "dot";
	x: number;
	y: number;
	width: number;
	dashOffset: number;
}

export interface QuadraticAtom extends RenderAtomBase {
	recipeId: "stroke";
	primitive: "quadratic";
	fromX: number;
	fromY: number;
	viaX: number;
	viaY: number;
	toX: number;
	toY: number;
	width: number;
	dashOffset: number;
}

export interface ShapeAtom extends RenderAtomBase {
	recipeId: "shape";
	primitive: "shape";
	shapeKind: NonNullable<SceneElementDescriptor["shapeKind"]>;
	shapeStart?: { x: number; y: number };
	shapeEnd?: { x: number; y: number };
	box: AabbBox;
}

export interface GlyphAtom extends RenderAtomBase {
	recipeId: "glyph";
	primitive: "glyph";
	grapheme: string;
	x: number;
	y: number;
	maxWidth: number;
}

export interface BitmapAtom extends RenderAtomBase {
	recipeId: "bitmap";
	primitive: "bitmap";
	value: string;
	box: AabbBox;
}

export type RenderAtom = DotAtom | QuadraticAtom | ShapeAtom | GlyphAtom | BitmapAtom;

export interface TextCharacterState {
	charId: string;
	afterId: string | null;
	grapheme: string;
	deleted: boolean;
	order: RenderOrderKey;
}

export interface SceneElementState {
	id: string;
	pageId: number;
	descriptor: SceneElementDescriptor;
	createOrder: RenderOrderKey;
	revision: number;
	deleted: boolean;
	matrix: AffineMatrix;
	points: Point[];
	atomRefs: number[];
	erasedIntervals: Map<string, Array<{ start: number; end: number }>>;
	characters: Map<string, TextCharacterState>;
}

export interface DirtyRenderMetrics {
	mode: "dirty" | "full";
	gridCells: number;
	candidateChunks: number;
	candidateAtoms: number;
	renderedAtoms: number;
}

export interface SceneStats {
	atoms: number;
	visibleAtoms: number;
	elements: number;
	orderBlocks: number;
	geometryChunks: number;
	gridReferences: number;
	largeChunks: number;
}
