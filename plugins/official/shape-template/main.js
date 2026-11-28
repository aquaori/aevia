/// <reference path="../../../../packages/plugin-sdk/index.d.ts" />
// @ts-check
apg.registerCommand("insert", () => {
  const template = /** @type {{ shapes: import("../../../../packages/plugin-sdk").ShapeRequest[] }} */ (/** @type {unknown} */ (apg.readResource()));
  if (!template || !Array.isArray(template.shapes) || template.shapes.length === 0) throw new Error("Invalid card template");
  apg.mutate(template.shapes);
  apg.preview("Card inserted");
});
