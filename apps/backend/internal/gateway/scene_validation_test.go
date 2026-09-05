package gateway

import (
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
