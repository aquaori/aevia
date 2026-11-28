// User-scoped export: reads the bounded scene snapshot and asks the host to save it.
// The guest never touches the filesystem; the host owns the name, MIME type and size budget.
apg.registerCommand("export", function () {
  var scene = apg.readScene();
  if (!scene || !Array.isArray(scene.items)) {
    apg.preview("Scene unavailable");
    return;
  }
  var primitives = {};
  for (var i = 0; i < scene.items.length; i++) {
    var primitive = String(scene.items[i].primitive);
    primitives[primitive] = (primitives[primitive] || 0) + 1;
  }
  var body = {
    revision: scene.revision,
    truncated: scene.truncated === true,
    elements: scene.items.length,
    primitives: primitives
  };
  apg.download({ name: "aevia-scene.json", mime: "application/json", text: JSON.stringify(body) });
  apg.preview("Scene exported");
});
