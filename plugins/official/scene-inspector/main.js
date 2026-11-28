/// <reference path="../../../..//packages/plugin-sdk/index.d.ts" />
// @ts-check
apg.registerCommand("inspect", () => {
  const scene = apg.readScene();
  if (!scene) { apg.preview("Scene unavailable"); return; }
  const count = new Set(scene.items.map(item => item.elementId)).size;
  apg.preview("Visible elements: " + count + (scene.truncated ? " (partial snapshot)" : ""));
});
