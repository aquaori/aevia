/// <reference path="../../../../packages/plugin-sdk/index.d.ts" />
// @ts-check
apg.registerCommand("insert", () => {
  const template = /** @type {{ elements?: import("../../../../packages/plugin-sdk").MutateRequest[] }} */ (/** @type {unknown} */ (apg.readResource()));
  if (!template || !Array.isArray(template.elements) || template.elements.length === 0) throw new Error("Invalid note template");
  apg.mutate(template.elements);
  apg.preview("Note inserted");
});
