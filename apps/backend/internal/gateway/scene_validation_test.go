package gateway

import (
	"encoding/json"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/auth"
)

func validScenePush() map[string]any {
	op := map[string]any{
		"schemaVersion":  float64(2),
		"opId":           "op-1",
		"elementId":      "element-1",
		"actorId":        "user-1",
		"roomId":         "room-1",
		"pageId":         float64(0),
		"lamport":        float64(1),
		"historyGroupId": "op-1",
		"kind":           "element.create",
		"payload": map[string]any{
			"descriptor": map[string]any{
				"elementKind": "path",
				"toolId":      "pen",
				"recipeId":    "stroke",
				"style": map[string]any{
					"color":         "#111827",
					"size":          float64(4),
					"strokePattern": "solid",
				},
			},
			"points": []any{
				map[string]any{"x": float64(0.1), "y": float64(0.2), "p": float64(0.5), "lamport": float64(1)},
			},
			"isComplete": true,
		},
	}
	return map[string]any{
		"id": "op-1",
		"cmd": map[string]any{
			"id":             "op-1",
			"type":           "scene-op",
			"schemaVersion":  float64(2),
			"userId":         "user-1",
			"roomId":         "room-1",
			"pageId":         float64(0),
			"lamport":        float64(1),
			"sceneOperation": op,
		},
	}
}

func sceneTestClient() *wsClient {
	return &wsClient{claims: auth.Claims{UserID: "user-1", RoomID: "room-1"}}
}

func TestValidateSceneCommandAcceptsV2Create(t *testing.T) {
	if code, reason, ok := validateSceneCommand(sceneTestClient(), "push-cmd", validScenePush()); !ok {
		t.Fatalf("expected valid scene operation, code=%s reason=%s", code, reason)
	}
}

func TestSceneOperationIDCharacterSet(t *testing.T) {
	for _, id := range []string{"op-1", "element_1:initial:0", "page:0"} {
		if !validID(id) {
			t.Errorf("expected valid ID %q", id)
		}
	}
	for _, id := range []string{"", "a b", "é", "a/b"} {
		if validID(id) {
			t.Errorf("expected invalid ID %q", id)
		}
	}
}

func TestSceneOperationsCanReferenceLegacyUnicodeIDs(t *testing.T) {
	data := validScenePush()
	op := data["cmd"].(map[string]any)["sceneOperation"].(map[string]any)
	op["elementId"] = "旧对象"
	if _, _, ok := validateSceneCommand(sceneTestClient(), "push-cmd", data); ok {
		t.Fatal("accepted a new non-ASCII element ID")
	}
	op["kind"] = "element.delete"
	op["payload"] = map[string]any{"elementIds": []any{"旧对象"}}
	if code, reason, ok := validateSceneCommand(sceneTestClient(), "push-cmd", data); !ok {
		t.Fatalf("legacy reference rejected: %s %s", code, reason)
	}
}

func TestValidateSceneCommandAcceptsPointlessElementCreate(t *testing.T) {
	data := validScenePush()
	op := data["cmd"].(map[string]any)["sceneOperation"].(map[string]any)
	payload := op["payload"].(map[string]any)
	descriptor := payload["descriptor"].(map[string]any)
	descriptor["elementKind"] = "shape"
	descriptor["toolId"] = "line"
	descriptor["recipeId"] = "shape"
	payload["points"] = []any{map[string]any{"x": "unused"}}

	if code, reason, ok := validateSceneCommand(sceneTestClient(), "push-cmd", data); !ok {
		t.Fatalf("expected valid pointless scene operation, code=%s reason=%s", code, reason)
	}
}

func TestValidateSceneCommandRejectsLegacyWrites(t *testing.T) {
	if code, _, ok := validateSceneCommand(sceneTestClient(), "cmd-start", map[string]any{}); ok || code != "UPGRADE_REQUIRED" {
		t.Fatalf("expected UPGRADE_REQUIRED, got code=%s ok=%v", code, ok)
	}
}

func TestValidateSceneCommandRejectsUnknownRecipe(t *testing.T) {
	data := validScenePush()
	cmd := data["cmd"].(map[string]any)
	op := cmd["sceneOperation"].(map[string]any)
	payload := op["payload"].(map[string]any)
	descriptor := payload["descriptor"].(map[string]any)
	descriptor["recipeId"] = "plugin-unknown"
	if code, _, ok := validateSceneCommand(sceneTestClient(), "push-cmd", data); ok || code != "UNSUPPORTED_RECIPE" {
		t.Fatalf("expected UNSUPPORTED_RECIPE, got code=%s ok=%v", code, ok)
	}
}

func TestValidateSceneCommandRejectsEnvelopeMismatch(t *testing.T) {
	data := validScenePush()
	data["cmd"].(map[string]any)["pageId"] = float64(2)
	if code, _, ok := validateSceneCommand(sceneTestClient(), "push-cmd", data); ok || code != "INVALID_SCENE_OPERATION" {
		t.Fatalf("expected INVALID_SCENE_OPERATION, got code=%s ok=%v", code, ok)
	}
}

func TestValidateSceneCommandAcceptsTextStylePatch(t *testing.T) {
	data := validScenePush()
	op := data["cmd"].(map[string]any)["sceneOperation"].(map[string]any)
	op["kind"] = "element.style"
	op["payload"] = map[string]any{
		"style": map[string]any{
			"fontSize":   float64(28),
			"fontWeight": float64(700),
			"textAlign":  "center",
		},
	}
	if code, reason, ok := validateSceneCommand(sceneTestClient(), "push-cmd", data); !ok {
		t.Fatalf("expected valid text style operation, code=%s reason=%s", code, reason)
	}
}

func TestValidateSceneCommandAcceptsAllRegisteredOperationKinds(t *testing.T) {
	cases := []struct {
		kind    string
		payload map[string]any
	}{
		{kind: "element.create", payload: validScenePush()["cmd"].(map[string]any)["sceneOperation"].(map[string]any)["payload"].(map[string]any)},
		{kind: "element.append", payload: map[string]any{
			"sourceStart": float64(0),
			"points":      []any{map[string]any{"x": float64(0.1), "y": float64(0.2), "p": float64(0.5), "lamport": float64(2)}},
		}},
		{kind: "element.transform", payload: map[string]any{
			"targets": []any{map[string]any{"elementId": "element-1", "deltaMatrix": []any{float64(1), float64(0), float64(0), float64(1), float64(2), float64(3)}}},
		}},
		{kind: "element.style", payload: map[string]any{"style": map[string]any{"color": "#123456"}}},
		{kind: "element.erase", payload: map[string]any{
			"targets": []any{map[string]any{
				"elementId": "element-1", "atomId": "atom-1", "intervals": []any{map[string]any{"start": float64(0), "end": float64(1)}},
			}},
		}},
		{kind: "element.delete", payload: map[string]any{"elementIds": []any{"element-1"}}},
		{kind: "text.patch", payload: map[string]any{"patches": []any{map[string]any{
			"type": "insert", "charId": "char-1", "grapheme": "界",
		}}}},
		{kind: "history.toggle", payload: map[string]any{"targetHistoryGroupId": "group-1", "enabled": false}},
		{kind: "page.clear", payload: map[string]any{"before": map[string]any{
			"opId": "op-1", "lamport": float64(1), "sourceIndex": float64(0), "subIndex": float64(0),
		}}},
	}

	for _, testCase := range cases {
		t.Run(testCase.kind, func(t *testing.T) {
			data := validScenePush()
			cmd := data["cmd"].(map[string]any)
			operation := cmd["sceneOperation"].(map[string]any)
			operation["kind"] = testCase.kind
			operation["payload"] = testCase.payload
			if code, reason, ok := validateSceneCommand(sceneTestClient(), "push-cmd", data); !ok {
				t.Fatalf("expected valid %s operation, code=%s reason=%s", testCase.kind, code, reason)
			}
		})
	}
}

func TestValidateSceneCommandRejectsMalformedPayloadForAllRegisteredOperationKinds(t *testing.T) {
	cases := []struct {
		kind    string
		payload map[string]any
	}{
		{kind: "element.create", payload: map[string]any{}},
		{kind: "element.append", payload: map[string]any{"sourceStart": float64(-1), "points": []any{}}},
		{kind: "element.transform", payload: map[string]any{"targets": []any{}}},
		{kind: "element.style", payload: map[string]any{"style": map[string]any{}}},
		{kind: "element.erase", payload: map[string]any{"targets": []any{}}},
		{kind: "element.delete", payload: map[string]any{"elementIds": []any{}}},
		{kind: "text.patch", payload: map[string]any{"patches": []any{}}},
		{kind: "history.toggle", payload: map[string]any{"targetHistoryGroupId": "", "enabled": true}},
		{kind: "page.clear", payload: map[string]any{"before": map[string]any{}}},
	}

	for _, testCase := range cases {
		t.Run(testCase.kind, func(t *testing.T) {
			data := validScenePush()
			operation := data["cmd"].(map[string]any)["sceneOperation"].(map[string]any)
			operation["kind"] = testCase.kind
			operation["payload"] = testCase.payload
			if code, _, ok := validateSceneCommand(sceneTestClient(), "push-cmd", data); ok || code != "INVALID_SCENE_OPERATION" {
				t.Fatalf("expected malformed %s to be rejected, got code=%s ok=%v", testCase.kind, code, ok)
			}
		})
	}
}

func TestValidateSceneCommandRejectsUnknownOperationKind(t *testing.T) {
	data := validScenePush()
	operation := data["cmd"].(map[string]any)["sceneOperation"].(map[string]any)
	operation["kind"] = "element.unknown"
	if code, _, ok := validateSceneCommand(sceneTestClient(), "push-cmd", data); ok || code != "UNSUPPORTED_SCENE_OPERATION" {
		t.Fatalf("expected unsupported operation to be rejected, got code=%s ok=%v", code, ok)
	}
}

func FuzzValidateScenePayloadNeverPanics(f *testing.F) {
	f.Add("element.create", []byte(`{"descriptor":{"elementKind":"path","toolId":"pen","recipeId":"stroke","style":{"color":"#111827","size":4,"strokePattern":"solid"}},"points":[{"x":0.1,"y":0.2,"p":0.5,"lamport":1}],"isComplete":true}`))
	f.Add("element.append", []byte(`{"sourceStart":0,"points":[{"x":0.2,"y":0.3,"p":0.6,"lamport":2}]}`))
	f.Add("element.transform", []byte(`{"targets":[{"elementId":"element-1","deltaMatrix":[1,0,0,1,2,3]}]}`))
	f.Add("text.patch", []byte(`{"patches":[{"type":"insert","charId":"char-1","grapheme":"界"}]}`))
	f.Add("page.clear", []byte(`{"before":{"opId":"op-1","lamport":1,"sourceIndex":0,"subIndex":0}}`))
	f.Fuzz(func(t *testing.T, kind string, payloadJSON []byte) {
		var payload map[string]any
		if err := json.Unmarshal(payloadJSON, &payload); err != nil || payload == nil {
			return
		}
		validateScenePayload(kind, payload)
	})
}
