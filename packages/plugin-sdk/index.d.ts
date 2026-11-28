/** APG API 1. Types only; the host injects the global apg object into QuickJS. */
export type DownloadMime = "application/json" | "text/plain" | "text/csv";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Shape = "rectangle" | "rounded-rectangle" | "ellipse" | "line" | "arrow";
export interface ShapeRequest {
  kind: "shape.create";
  shape: Shape;
  start: { x: number; y: number };
  end: { x: number; y: number };
  color: string;
  size: number;
  opacity?: number;
  fillColor?: string;
}
/** A native text element (`text.create`) or sticky note (`sticky.create`). The box is
 * normalised to the page (0..1); the host assigns identity, clock, page and history group. */
export interface TextRequest {
  kind: "text.create" | "sticky.create";
  box: { x: number; y: number; width: number; height: number };
  text: string;
  color: string;
  fontSize?: number;
  fillColor?: string;
}
export type MutateRequest = ShapeRequest | TextRequest;
export interface SceneSnapshot {
  revision: number;
  truncated: boolean;
  items: { elementId: string; primitive: string; bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } }[];
}
export interface SharedState {
  revision: number;
  /** Shared-state schema the host stored this value under (0 = unversioned). A package whose
   * manifest declares a lower `stateSchemaVersion` cannot overwrite it; the write fails 409. */
  schemaVersion: number;
  value: Json;
}

/* ---- Manifest contract -------------------------------------------------- */
/* Mirrors the host validator (Go catalog.go and frontend apgCatalog.ts); the
 * same manifest must be accepted or rejected identically by all three. */

/** The only plugin API version this SDK documents. */
export type ApgApiVersion = 1;
export type ApgManifestVersion = 1 | 2;
export type ApgScope = "system" | "user";
/** `scene.write` and `storage.shared` are refused for `user` scope. */
export type ApgPermission = "scene.read" | "scene.write" | "ui.preview" | "storage.shared";
export type ApgBrushBase = "pen" | "pencil" | "highlighter";

export interface ApgCommandContribution {
  id: string;
  label: string;
  /** Only `Alt+Shift+<digit>`; a chord claimed twice is not bound at all. */
  shortcut?: string;
  /** `assets/**.json`, system scope only. */
  resource?: string;
}

export interface ApgPaletteContribution {
  id: string;
  label: string;
  colors: string[];
}

export interface ApgBrushContribution {
  id: string;
  label: string;
  base: ApgBrushBase;
  color?: string;
  size?: number;
  opacity?: number;
}

export interface ApgContributes {
  palettes?: ApgPaletteContribution[];
  brushes?: ApgBrushContribution[];
  commands?: ApgCommandContribution[];
}

export interface ApgManifestV1 {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  scope: ApgScope;
  contributes: ApgContributes;
}

export interface ApgManifestV2 {
  manifestVersion: 2;
  /** Required for v2; the host does not infer a default. */
  apiVersion: ApgApiVersion;
  id: string;
  name: string;
  version: string;
  scope: ApgScope;
  /** Executable entry point; the only accepted value is `main.js`. */
  main: "main.js";
  permissions?: ApgPermission[];
  contributes: ApgContributes;
}

export type ApgManifest = ApgManifestV1 | ApgManifestV2;

export interface PluginAPI {
  registerCommand(id: string, handler: () => void): void;
  onActivate(handler: () => void): void;
  onDeactivate(handler: () => void): void;
  readScene(): SceneSnapshot | null;
  readSharedState(): SharedState | null;
  readResource(): Json;
  writeSharedState(value: Json): void;
  preview(text: string): void;
  /**
   * Save a file the user asked for (export). The host writes it under `name`; the guest
   * never touches the filesystem. `mime` is limited to application/json, text/plain or
   * text/csv, and the body to 64 KiB.
   */
  download(file: { name: string; mime: DownloadMime; text: string }): void;
  /** Draw 1..8 native shapes. A bundle is committed under one host history group, so a single
   * undo removes the whole template; every element is an ordinary scene operation. */
  /** Insert 1..8 native elements as one undo group. */
  mutate(request: MutateRequest | MutateRequest[]): void;
}
declare global { const apg: PluginAPI; }
