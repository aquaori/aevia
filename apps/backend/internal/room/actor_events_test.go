package room

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/domain"
	"collaborative-whiteboard/apps/backend/internal/storage"
)

func newRoomActorTestHarness(t *testing.T, roomID string) (*storage.Store, *Registry, *Actor) {
	t.Helper()
	cfg := config.Config{
		DBPath:                 filepath.Join(t.TempDir(), "room.sqlite"),
		RoomReliableQueue:      32,
		RoomRealtimeQueue:      32,
		ConnectionSendMessages: 32,
		DBBatchSize:            8,
		DBBatchWindow:          time.Millisecond,
		InitPreloadPageCount:   2,
		InitCommandChunkSize:   50,
		InitFlatPointChunkSize: 500,
		WALCheckpointInterval:  time.Hour,
		WALCheckpointBytes:     1 << 30,
		WALTruncateBytes:       1 << 31,
	}
	store, err := storage.Open(cfg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()
	if err := store.CreateRoom(ctx, domain.Room{RoomID: roomID, Name: "Test Room", TotalPage: 2}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	registry := NewRegistry(store, cfg)
	t.Cleanup(func() {
		shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		registry.Shutdown(shutCtx)
	})
	actor, err := registry.Get(ctx, roomID)
	if err != nil {
		t.Fatalf("registry get: %v", err)
	}
	return store, registry, actor
}

func drainMessages(ch <-chan Outbound, count int, timeout time.Duration) []Outbound {
	out := make([]Outbound, 0, count)
	deadline := time.After(timeout)
	for len(out) < count {
		select {
		case msg := <-ch:
			out = append(out, msg)
		case <-deadline:
			return out
		}
	}
	return out
}

func TestEventDecodeHelpers(t *testing.T) {
	pts := pointsFromAny([]map[string]any{{"x": 0.1, "y": 0.2, "p": 0.5, "lamport": 1.0}})
	if len(pts) != 1 || pts[0].X != 0.1 {
		t.Fatalf("unexpected points from map slice: %+v", pts)
	}
	ptsAny := pointsFromAny([]any{map[string]any{"x": 0.3, "y": 0.4}})
	if len(ptsAny) != 1 || ptsAny[0].X != 0.3 {
		t.Fatalf("unexpected points from []any: %+v", ptsAny)
	}
	if len(pointsFromAny([]domain.Point{{X: 0.9}})) != 1 {
		t.Fatal("expected direct []domain.Point passthrough")
	}
	if len(pointsFromAny(struct{ Bad func() }{Bad: func() {}})) != 0 {
		t.Fatal("expected unmarshalable value to return nil")
	}
	if got := mapSlice([]any{map[string]any{"a": 1}}); len(got) != 1 {
		t.Fatalf("unexpected mapSlice: %+v", got)
	}
	if got := stringSlice([]any{"x", "y"}); len(got) != 2 {
		t.Fatalf("unexpected stringSlice: %+v", got)
	}
	if frame := encodeCommandUpdate("cmd-1", []domain.Point{{X: 0.2, Y: 0.3}}); len(frame) == 0 {
		t.Fatal("expected encoded binary frame from domain points")
	}
	if frame := encodeCommandUpdate("cmd-1", []map[string]any{{"x": 0.2, "y": 0.3}}); len(frame) == 0 {
		t.Fatal("expected encoded binary frame from map points")
	}
}

func TestActorLifecycleCommandsAndDegradedPaths(t *testing.T) {
	store, registry, actor := newRoomActorTestHarness(t, "room-actor-1")
	c1Send := make(chan Outbound, 64)
	c2Send := make(chan Outbound, 64)

	if _, err := actor.Join(ClientInfo{ID: "c1", UserID: "u1", UserName: "Alice", PageID: 0, Send: c1Send}, 0, 0); err != nil {
		t.Fatalf("join c1: %v", err)
	}
	if _, err := actor.Join(ClientInfo{ID: "c2", UserID: "u2", UserName: "Bob", PageID: 0, Send: c2Send}, 0, 0); err != nil {
		t.Fatalf("join c2: %v", err)
	}
	defer actor.Leave("c1")
	defer actor.Leave("c2")

	// Snapshots and PageReview
	if snap, err := actor.Snapshot(0); err != nil || snap.SnapshotVersion != 0 {
		t.Fatalf("snapshot: %v", err)
	}
	if review, err := actor.PageReview(); err != nil || len(review.Pages) == 0 {
		t.Fatalf("page review: %+v err=%v", review, err)
	}

	// Realtime + member list + history + batch reject
	_ = actor.Event("c1", "mouseMove", map[string]any{"x": 0.5, "userId": "forged"}, false)
	_ = actor.Event("c1", "get-member-list", map[string]any{}, false)
	_ = actor.Event("c1", "load-page-history", map[string]any{"requestId": "req-1", "pageId": 0}, false)
	_ = actor.Event("c1", "cmd-batch-move", map[string]any{}, false)
	_ = actor.Event("c1", "cmd-batch-update", map[string]any{}, false)

	// Legacy start -> update -> point gap -> duplicate prefix -> stop -> undo -> redo -> delete -> page-add
	_ = actor.Event("c1", "cmd-start", map[string]any{
		"cmd": map[string]any{"id": "legacy-1", "type": "path", "pageId": 0, "points": []any{map[string]any{"x": 0.1, "y": 0.1}}},
	}, false)
	_ = actor.BinaryEvent("c1", "cmd-update", map[string]any{
		"cmdId":          "legacy-1",
		"fromPointIndex": 1,
		"points":         []domain.Point{{X: 0.2, Y: 0.2}},
	}, []byte{1, 2, 3})
	// Duplicate prefix triggers idempotent accepted ack
	_ = actor.Event("c1", "cmd-update", map[string]any{
		"cmdId":          "legacy-1",
		"fromPointIndex": 0,
		"points":         []any{map[string]any{"x": 0.1, "y": 0.1}},
	}, false)
	// Point gap triggers POINT_GAP rejection
	_ = actor.Event("c1", "cmd-update", map[string]any{
		"cmdId":          "legacy-1",
		"fromPointIndex": 99,
		"points":         []any{map[string]any{"x": 0.9, "y": 0.9}},
	}, false)
	_ = actor.Event("c1", "cmd-stop", map[string]any{
		"cmdId":  "legacy-1",
		"points": []any{map[string]any{"x": 0.3, "y": 0.3}},
		"cmd":    map[string]any{"box": map[string]any{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}},
	}, false)
	_ = actor.Event("c1", "undo-cmd", map[string]any{"cmdId": "legacy-1"}, false)
	_ = actor.Event("c1", "redo-cmd", map[string]any{"cmdId": "legacy-1"}, false)
	_ = actor.Event("c1", "cmd-page-add", map[string]any{}, false)
	_ = actor.PageChange("c1", PageChangeRequest{RequestID: 1})
	_ = actor.Event("c1", "delete-cmd", map[string]any{"cmdId": "legacy-1"}, false)

	msgs := drainMessages(c1Send, 20, 500*time.Millisecond)
	if len(msgs) < 5 {
		t.Fatalf("expected actor responses on c1Send, got %d", len(msgs))
	}

	// Draining rejects writes while allowing realtime
	registry.BeginDraining("maintenance")
	_ = actor.Event("c1", "mouseMove", map[string]any{"x": 0.2}, false)
	_ = actor.Event("c1", "cmd-page-add", map[string]any{}, false)

	// NotifyWriteFailure puts actor into read-only mode
	registry.reportWriteFailure("room-actor-1", store.Ready(context.Background()))
	actor.NotifyWriteFailure(context.Canceled)
	_ = actor.Event("c1", "delete-cmd", map[string]any{"cmdId": "missing"}, false)

	drainMessages(c1Send, 10, 200*time.Millisecond)
	drainMessages(c2Send, 10, 200*time.Millisecond)

	// Delete room actor cleanly via Registry.Delete
	if err := registry.Delete(context.Background(), "room-actor-1"); err != nil {
		t.Fatalf("registry delete: %v", err)
	}
}
