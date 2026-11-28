/// <reference path="../../../../packages/plugin-sdk/index.d.ts" />
// @ts-check
function count() {
  const current = apg.readSharedState()?.value;
  return typeof current === "number" && Number.isSafeInteger(current) && current >= 0 ? current : 0;
}
apg.registerCommand("increment", () => {
  const next = count() + 1;
  apg.writeSharedState(next);
  apg.preview("Counter: " + next);
});
apg.registerCommand("read", () => apg.preview("Counter: " + count()));
