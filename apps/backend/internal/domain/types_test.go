package domain

import (
	"encoding/json"
	"testing"
)

func TestCommandDataMethodsSnapshotAndJSON(t *testing.T) {
	var nilCmd *CommandData
	if nilCmd.Clone() != nil || nilCmd.Snapshot() != nil || nilCmd.Get("id") != nil || nilCmd.Points() != nil {
		t.Fatal("expected nil receivers to handle safely")
	}
	nilCmd.RangeFields(func(string, any) bool {
		t.Fatal("unexpected field on nil command")
		return true
	})
	nilCmd.Set("k", "v")
	nilCmd.SetPoints([]Point{{X: 1, Y: 2}})

	raw, err := nilCmd.MarshalJSON()
	if err != nil || string(raw) != "null" {
		t.Fatalf("expected nil MarshalJSON 'null', got %q %v", string(raw), err)
	}

	nested := NewCommand(map[string]any{
		"id":   "nested",
		"type": "note",
	})
	cmd := NewCommand(map[string]any{
		"id":        "cmd-1",
		"type":      "path",
		"pageId":    1,
		"isDeleted": false,
		"points": []map[string]any{
			{"x": 10.0, "y": 20.0, "p": 0.5, "lamport": 2.0},
		},
		"child": nested,
		"meta":  map[string]any{"tag": "v1"},
		"pts":   []Point{{X: 1, Y: 2}},
		"flats": []FlatPoint{{CmdID: "c1"}},
		"cmds":  []Command{nested},
		"maps":  []map[string]any{{"k": "v"}},
		"anys":  []any{nested, "x", nil},
	})
	cmd.SetIdentity("user-1", "room-1")

	if cmd.ID() != "cmd-1" || cmd.Type() != "path" || cmd.UserID() != "user-1" {
		t.Fatalf("unexpected identity fields: %s %s %s", cmd.ID(), cmd.Type(), cmd.UserID())
	}
	if pageID, ok := cmd.PageID(); !ok || pageID != 1 {
		t.Fatalf("expected pageId 1, got %d %v", pageID, ok)
	}
	if cmd.IsDeleted() {
		t.Fatal("expected not deleted")
	}

	cloned := cmd.Clone()
	snap := cmd.Snapshot()
	if cloned.ID() != "cmd-1" || snap.ID() != "cmd-1" {
		t.Fatal("expected clone/snapshot to preserve id")
	}

	keys := 0
	cmd.RangeFields(func(key string, _ any) bool {
		keys++
		return keys < 2
	})
	if keys != 2 {
		t.Fatalf("expected early stop at 2 keys, got %d", keys)
	}

	cmd.Set("points", []any{map[string]any{"x": 3, "y": 4, "p": 0.8, "lamport": 5}})
	if pts, ok := cmd.Get("points").([]Point); !ok || len(pts) != 1 || pts[0].X != 3 {
		t.Fatalf("unexpected points via Get/Set: %+v", cmd.Get("points"))
	}
	cmd.Set("points", "bad-json-shape")
	if len(cmd.Points()) != 0 {
		t.Fatalf("expected invalid points conversion to yield empty slice, got %+v", cmd.Points())
	}
	cmd.Set("points", []Point{{X: 5, Y: 6, P: 0.7, Lamport: 9}})

	payload, err := cmd.Payload()
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	decoded, err := CommandFromPayload(payload)
	if err != nil || decoded.ID() != "cmd-1" {
		t.Fatalf("CommandFromPayload failed: %v %+v", err, decoded)
	}
	if _, err := CommandFromPayload([]byte("{bad")); err == nil {
		t.Fatal("expected invalid JSON error")
	}

	// Reset fields map nil path
	blank := &CommandData{}
	blank.Set("a", 1)
	if blank.Get("a") != 1 {
		t.Fatal("expected blank.Set to initialize map")
	}
}

func TestFlattenScenePathFragmentSortAndHelpers(t *testing.T) {
	pathCmd := NewCommand(map[string]any{
		"id":     "p1",
		"type":   "path",
		"pageId": 0,
		"points": []Point{{X: 1, Y: 2, P: 0.5, Lamport: 10}, {X: 3, Y: 4, P: 0.6, Lamport: 11}},
	})
	pathCmd.SetIdentity("u1", "r1")

	if flats := FlattenCommand(pathCmd); len(flats) != 2 || flats[1].PointIndex != 1 {
		t.Fatalf("unexpected FlattenCommand: %+v", flats)
	}
	if flats := FlattenCommandRange(pathCmd, -1); len(flats) != 2 {
		t.Fatalf("expected negative startIndex clamped to 0, got %d", len(flats))
	}
	if flats := FlattenCommandRange(pathCmd, 99); flats != nil {
		t.Fatalf("expected out-of-range startIndex nil, got %+v", flats)
	}
	if flats := FlattenCommand(NewCommand(map[string]any{"id": "t1", "type": "text", "pageId": 0})); flats != nil {
		t.Fatalf("expected non-path nil")
	}
	if flats := FlattenCommand(NewCommand(map[string]any{"id": "", "type": "path", "pageId": -1})); flats != nil {
		t.Fatalf("expected invalid path metadata nil")
	}

	// ScenePathFragmentFromCommand cases
	if _, ok := ScenePathFragmentFromCommand(nil); ok {
		t.Fatal("expected nil command false")
	}
	if _, ok := ScenePathFragmentFromCommand(NewCommand(map[string]any{"type": "scene-op"})); ok {
		t.Fatal("expected missing sceneOperation false")
	}
	if _, ok := ScenePathFragmentFromCommand(NewCommand(map[string]any{
		"type":           "scene-op",
		"sceneOperation": map[string]any{"opId": "o1", "elementId": "e1", "pageId": 0},
	})); ok {
		t.Fatal("expected missing payload false")
	}
	if _, ok := ScenePathFragmentFromCommand(NewCommand(map[string]any{
		"type": "scene-op",
		"sceneOperation": map[string]any{
			"kind":    "element.create",
			"pageId":  0,
			"opId":    "",
			"payload": map[string]any{},
		},
	})); ok {
		t.Fatal("expected missing opId false")
	}
	if _, ok := ScenePathFragmentFromCommand(NewCommand(map[string]any{
		"type": "scene-op",
		"sceneOperation": map[string]any{
			"kind":      "element.create",
			"opId":      "o1",
			"elementId": "e1",
			"pageId":    0,
			"payload":   map[string]any{"descriptor": map[string]any{"elementKind": "shape"}},
		},
	})); ok {
		t.Fatal("expected non-path descriptor false")
	}

	createCmd := NewCommand(map[string]any{
		"type":   "scene-op",
		"userId": "u1",
		"sceneOperation": map[string]any{
			"kind":      "element.create",
			"opId":      "op-create",
			"elementId": "el-1",
			"pageId":    1,
			"lamport":   7,
			"payload": map[string]any{
				"descriptor": map[string]any{
					"elementKind": "path",
					"recipeId":    "stroke",
					"toolId":      "highlighter",
					"style":       map[string]any{"color": "#ff0", "size": 5, "strokePattern": "dashed"},
				},
				"points": []Point{{X: 1, Y: 1}},
			},
		},
	})
	frag, ok := ScenePathFragmentFromCommand(createCmd)
	if !ok || !frag.IsCreate || frag.Tool != "highlighter" || len(frag.Points) != 1 {
		t.Fatalf("unexpected create fragment: %+v %v", frag, ok)
	}

	appendCmd := NewCommand(map[string]any{
		"type": "scene-op",
		"sceneOperation": map[string]any{
			"kind":      "element.append",
			"opId":      "op-app",
			"elementId": "el-1",
			"pageId":    1,
			"lamport":   8,
			"payload": map[string]any{
				"sourceStart": 2,
				"points":      []Point{{X: 9, Y: 9}},
			},
		},
	})
	frag, ok = ScenePathFragmentFromCommand(appendCmd)
	if !ok || frag.IsCreate || frag.SourceStart != 2 || len(frag.Points) != 1 {
		t.Fatalf("unexpected append fragment: %+v %v", frag, ok)
	}

	unknownKindCmd := NewCommand(map[string]any{
		"type": "scene-op",
		"sceneOperation": map[string]any{
			"kind":      "element.delete",
			"opId":      "op-del",
			"elementId": "el-1",
			"pageId":    1,
			"payload":   map[string]any{},
		},
	})
	if _, ok := ScenePathFragmentFromCommand(unknownKindCmd); ok {
		t.Fatal("expected unknown kind false")
	}

	// SortCommands and primitive extractors
	cmds := []Command{
		NewCommand(map[string]any{"id": "b", "lamport": 5}),
		NewCommand(map[string]any{"id": "a", "lamport": 5}),
		NewCommand(map[string]any{"id": "z", "lamport": 2}),
	}
	SortCommands(cmds)
	if cmds[0].ID() != "z" || cmds[1].ID() != "a" || cmds[2].ID() != "b" {
		t.Fatalf("unexpected SortCommands order: %s %s %s", cmds[0].ID(), cmds[1].ID(), cmds[2].ID())
	}

	if IntDefault(int64(4), 0) != 4 || IntDefault(uint64(5), 0) != 5 || IntDefault(uint(6), 0) != 6 || IntDefault("x", 9) != 9 {
		t.Fatal("IntDefault conversions failed")
	}
	if FloatDefault(float32(1.5), 0) != 1.5 || FloatDefault(int64(3), 0) != 3 || FloatDefault("bad", 2.5) != 2.5 {
		t.Fatal("FloatDefault conversions failed")
	}
	if StringDefault("", "fb") != "fb" || StringDefault("ok", "fb") != "ok" {
		t.Fatal("StringDefault failed")
	}
	if NowMillis() <= 0 {
		t.Fatal("expected positive NowMillis")
	}
	_, _ = json.Marshal(cmds[0])
}
