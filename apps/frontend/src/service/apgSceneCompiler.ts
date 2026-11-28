import { SCENE_SCHEMA_VERSION, validateSceneOperation, type Command, type SceneOperationEnvelopeV2, type ShapeKind } from "@collaborative-whiteboard/shared";

export interface ApgSceneContext { actorId: string; roomId: string; pageId: number; allocateId(): string; nextLamport(): number }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const point = (v: unknown): v is {x: number; y: number} => record(v) && Object.keys(v).length === 2 && num(v.x, 0, 1) && num(v.y, 0, 1);
const color = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const shapes = ["rectangle", "rounded-rectangle", "ellipse", "line", "arrow"];
/** One plugin invocation may contribute a small bundle of native elements so a template is one
 * undo step (all operations share a host-generated history group). The bundle is still a set of
 * ordinary scene operations: the server orders and persists them like any native drawing, so
 * replay never needs the plugin. */
export const MAX_APG_SHAPE_BUNDLE = 8;
export const MAX_APG_TEXT_LENGTH = 200;

interface ValidShape { kind: "shape"; shape: ShapeKind; start: {x: number; y: number}; end: {x: number; y: number}; color: string; size: number; opacity?: number; fillColor?: string }
interface ValidText { kind: "text"; elementKind: "text" | "sticky"; box: {x: number; y: number; width: number; height: number}; text: string; color: string; fontSize: number; fillColor?: string }

function parseShape(request: unknown): ValidShape {
  if (!record(request) || Object.keys(request).some(k => !["kind","shape","start","end","color","size","opacity","fillColor"].includes(k)) ||
      request.kind !== "shape.create" || typeof request.shape !== "string" || !shapes.includes(request.shape) ||
      !point(request.start) || !point(request.end) || !color(request.color) || !num(request.size, 0.1, 30) ||
      (request.opacity !== undefined && !num(request.opacity, 0, 1)) ||
      (request.fillColor !== undefined && !color(request.fillColor))) throw new Error("APG invalid native shape");
  const start = {x: request.start.x, y: request.start.y}, end = {x: request.end.x, y: request.end.y};
  if (Math.max(start.x,end.x) - Math.min(start.x,end.x) < 0.001 && Math.max(start.y,end.y) - Math.min(start.y,end.y) < 0.001) throw new Error("APG empty shape");
  return { kind: "shape", shape: request.shape as ShapeKind, start, end, color: request.color, size: request.size,
    ...(request.opacity !== undefined ? { opacity: request.opacity as number } : {}),
    ...(request.fillColor !== undefined ? { fillColor: request.fillColor as string } : {}) };
}

/** Text and sticky notes are native elements too (`recipeId: "glyph"`), so a plugin can place a
 * caption or a note without inventing a scene type: the peer renders it as an ordinary element
 * and replay never needs the plugin. The guest still controls only box, text and style. */
/** Control characters are rejected because they corrupt a shared text element for every peer.
 * Tab, newline and carriage return are allowed. */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

function parseText(request: unknown): ValidText {
  const elementKind = request && record(request) && request.kind === "sticky.create" ? "sticky" : "text";
  if (!record(request) || Object.keys(request).some(k => !["kind","box","text","color","fontSize","fillColor"].includes(k)) ||
      request.kind !== (elementKind === "sticky" ? "sticky.create" : "text.create") ||
      !record(request.box) || Object.keys(request.box).length !== 4 ||
      !num(request.box.x, 0, 1) || !num(request.box.y, 0, 1) ||
      !num(request.box.width, 0.02, 0.9) || !num(request.box.height, 0.02, 0.9) ||
      request.box.x + request.box.width > 1.0001 || request.box.y + request.box.height > 1.0001 ||
      typeof request.text !== "string" || request.text.length === 0 || request.text.length > MAX_APG_TEXT_LENGTH ||
      hasControlCharacter(request.text) ||
      !color(request.color) ||
      (request.fontSize !== undefined && !num(request.fontSize, 1, 96)) ||
      (request.fillColor !== undefined && !color(request.fillColor))) throw new Error("APG invalid native text");
  const box = { x: request.box.x, y: request.box.y, width: request.box.width, height: request.box.height };
  return { kind: "text", elementKind, box, text: request.text, color: request.color,
    fontSize: (request.fontSize as number | undefined) ?? 20,
    ...(request.fillColor !== undefined ? { fillColor: request.fillColor as string } : {}) };
}

const parseRequest = (request: unknown): ValidShape | ValidText => {
  if (record(request) && (request.kind === "text.create" || request.kind === "sticky.create")) return parseText(request);
  return parseShape(request);
};

const shapeBox = (shape: ValidShape) => {
  const minX = Math.min(shape.start.x, shape.end.x), minY = Math.min(shape.start.y, shape.end.y);
  const maxX = Math.max(shape.start.x, shape.end.x), maxY = Math.max(shape.start.y, shape.end.y);
  return { minX, minY, maxX, maxY, width: maxX-minX, height: maxY-minY };
};

/** Compile 1..8 validated elements. Guest controls only geometry, text and style: identity,
 * clock, page, history group and descriptor shape stay host-side. */
export function compileApgSceneMutations(request: unknown, ctx: ApgSceneContext): Partial<Command>[] {
  const requests = Array.isArray(request) ? request : [request];
  if (requests.length < 1 || requests.length > MAX_APG_SHAPE_BUNDLE) throw new Error("APG invalid native shape bundle");
  const parsed = requests.map(parseRequest);
  if (!ctx.actorId || !ctx.roomId || !Number.isSafeInteger(ctx.pageId) || ctx.pageId < 0) throw new Error("APG invalid host context");
  const ids = parsed.map(() => ctx.allocateId());
  const historyGroupId = ids[0]!;
  return parsed.map((item, index) => {
    const id = ids[index]!;
    const lamport = ctx.nextLamport();
    const box = item.kind === "shape" ? shapeBox(item) : { minX: item.box.x, minY: item.box.y, maxX: item.box.x + item.box.width, maxY: item.box.y + item.box.height, width: item.box.width, height: item.box.height };
    const descriptor = item.kind === "shape" ? {
      elementKind: "shape" as const, recipeId: "shape" as const, toolId: item.shape, shapeKind: item.shape,
      shapeStart: item.start, shapeEnd: item.end, box,
      style: { color: item.color, size: item.size, strokePattern: "solid" as const,
        ...(item.opacity !== undefined ? { opacity: item.opacity } : {}),
        ...(item.fillColor !== undefined ? { fillColor: item.fillColor } : {}) },
    } : {
      elementKind: item.elementKind, recipeId: "glyph" as const, toolId: item.elementKind, box,
      text: item.text,
      style: { color: item.color, size: 2, strokePattern: "solid" as const, fontSize: item.fontSize,
        ...(item.fillColor !== undefined ? { fillColor: item.fillColor } : {}) },
    };
    const op: SceneOperationEnvelopeV2 = {
      schemaVersion: SCENE_SCHEMA_VERSION, kind: "element.create", opId: id, elementId: id, historyGroupId,
      actorId: ctx.actorId, roomId: ctx.roomId, pageId: ctx.pageId, lamport,
      payload: { isComplete: true, descriptor }
    };
    if (!validateSceneOperation(op).ok) throw new Error("APG native operation rejected");
    return { id, type: "scene-op", color: item.color, size: item.kind === "shape" ? item.size : 2, userId: ctx.actorId, roomId: ctx.roomId, pageId: ctx.pageId, timestamp: Date.now(), isDeleted: false, box, lamport, schemaVersion: SCENE_SCHEMA_VERSION, sceneOperation: op };
  });
}

/** Single-element convenience used by the sandbox unit tests; rejects bundles so callers that
 * expect exactly one operation cannot silently drop the rest. */
export function compileApgSceneMutation(request: unknown, ctx: ApgSceneContext): Partial<Command> {
  if (Array.isArray(request)) throw new Error("APG invalid native shape");
  return compileApgSceneMutations(request, ctx)[0]!;
}
