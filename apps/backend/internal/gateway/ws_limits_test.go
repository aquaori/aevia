package gateway

import (
	"testing"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func testClient() *wsClient {
	return &wsClient{limits: wsClientLimits{
		maxPointsPerUpdate:  4,
		maxPointsPerCommand: 8,
		maxBatchCommands:    3,
	}}
}

func jsonPoints(count int) []any {
	points := make([]any, count)
	for i := range points {
		points[i] = map[string]any{"x": 0, "y": 0}
	}
	return points
}

func TestValidateIncomingJSONLimits(t *testing.T) {
	client := testClient()

	if !client.validateIncoming("cmd-update", map[string]any{"points": jsonPoints(4)}) {
		t.Fatal("expected an update at the limit to be accepted")
	}
	if client.validateIncoming("cmd-update", map[string]any{"points": jsonPoints(5)}) {
		t.Fatal("expected an oversized update to be rejected")
	}
	if client.validateIncoming("cmd-batch-update", map[string]any{"updates": jsonPoints(4)}) {
		t.Fatal("expected an oversized batch to be rejected")
	}
	if client.validateIncoming("cmd-start", map[string]any{"cmd": map[string]any{"points": jsonPoints(9)}}) {
		t.Fatal("expected an oversized command to be rejected")
	}
	if !client.validateIncoming("mouseMove", map[string]any{}) {
		t.Fatal("expected unlimited event types to pass through")
	}
}

// TestValidateIncomingBinaryLimits covers the gap this fix closes: the binary
// frame carries the overwhelming majority of cmd-update traffic, and it used to
// skip validation entirely, leaving WS_MAX_POINTS_PER_UPDATE unenforced.
func TestValidateIncomingBinaryLimits(t *testing.T) {
	client := testClient()

	within := map[string]any{"points": make([]domain.Point, 4)}
	if !client.validateIncomingBinary("cmd-update", within) {
		t.Fatal("expected a binary update at the limit to be accepted")
	}

	over := map[string]any{"points": make([]domain.Point, 5)}
	if client.validateIncomingBinary("cmd-update", over) {
		t.Fatal("expected an oversized binary update to be rejected")
	}
	if client.validateIncomingBinary("cmd-stop", over) {
		t.Fatal("expected an oversized binary stop to be rejected")
	}

	commandOver := map[string]any{"points": make([]domain.Point, 9)}
	if client.validateIncomingBinary("cmd-start", commandOver) {
		t.Fatal("expected an oversized binary command to be rejected")
	}
	if !client.validateIncomingBinary("mouseMove", map[string]any{}) {
		t.Fatal("expected realtime frames to pass through")
	}
}

func TestDecodedPointCountHandlesBothShapes(t *testing.T) {
	if got := decodedPointCount(make([]domain.Point, 3)); got != 3 {
		t.Fatalf("expected 3 for []domain.Point, got %d", got)
	}
	if got := decodedPointCount(jsonPoints(2)); got != 2 {
		t.Fatalf("expected 2 for []any, got %d", got)
	}
	if got := decodedPointCount("not points"); got != 0 {
		t.Fatalf("expected 0 for an unexpected type, got %d", got)
	}
}
