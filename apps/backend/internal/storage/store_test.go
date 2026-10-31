package storage

import (
	"context"
	"regexp"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func TestOpenStoreReadyAndMetrics(t *testing.T) {
	cfg := testStoreConfig(t)
	store := openTestStore(t)
	ctx := context.Background()

	if err := store.Ready(ctx); err != nil {
		t.Fatalf("expected a freshly opened store to be ready, got %v", err)
	}
	if err := store.Flush(ctx); err != nil {
		t.Fatalf("flush on an idle store: %v", err)
	}

	metrics := store.Metrics()
	writer, ok := metrics["writer"].(map[string]any)
	if !ok {
		t.Fatalf("expected writer metrics, got %T", metrics["writer"])
	}
	if degraded, _ := writer["degraded"].(bool); degraded {
		t.Fatal("a fresh writer must not report itself degraded")
	}
	if queueCap, _ := writer["queueCap"].(int); queueCap != cfg.DBBatchSize*16 {
		t.Fatalf("expected the writer queue capacity to be 16 batches, got %v", writer["queueCap"])
	}
	if queueLen, _ := writer["queueLen"].(int); queueLen != 0 {
		t.Fatalf("expected an empty writer queue, got %v", writer["queueLen"])
	}
	wal, ok := metrics["wal"].(map[string]any)
	if !ok {
		t.Fatalf("expected wal metrics, got %T", metrics["wal"])
	}
	for _, key := range []string{
		"sizeBytes", "lastCheckpointAt", "lastCheckpointMs", "lastCheckpointBusy",
		"lastCheckpointLog", "lastCheckpointDone", "checkpointFailures", "lastMode",
	} {
		if _, ok := wal[key]; !ok {
			t.Fatalf("expected %q in the wal metrics, got %+v", key, wal)
		}
	}
}

func TestZeroValueStoreMetricsAndFlush(t *testing.T) {
	// Metrics and Flush must be safe before Open has finished wiring the writer:
	// both are called from health/metrics paths that can run during startup.
	store := &Store{}

	metrics := store.Metrics()
	writer, ok := metrics["writer"].(map[string]any)
	if !ok {
		t.Fatalf("expected writer metrics, got %T", metrics["writer"])
	}
	if queueLen, _ := writer["queueLen"].(int); queueLen != 0 {
		t.Fatalf("expected a zero queue length, got %v", writer["queueLen"])
	}
	if degraded, _ := writer["degraded"].(bool); degraded {
		t.Fatal("a nil writer must not report itself degraded")
	}
	if err := store.Flush(context.Background()); err != nil {
		t.Fatalf("expected a nil-writer flush to be a no-op, got %v", err)
	}
}

func TestOpenFailsWhenTheDatabasePathIsUnusable(t *testing.T) {
	cfg := testStoreConfig(t)
	// A directory can never be opened as a SQLite database; migrations must
	// surface that as an Open error instead of leaving a half-initialised store.
	cfg.DBPath = t.TempDir()

	store, err := Open(cfg)
	if err == nil {
		_ = store.Close()
		t.Fatal("expected Open to fail for a directory DB path")
	}
}

func TestRoomLifecycle(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	exists, err := store.HasRoom(ctx, "room-1")
	if err != nil || exists {
		t.Fatalf("expected an unknown room to be absent, exists=%v err=%v", exists, err)
	}

	if err := store.CreateRoom(ctx, domain.Room{
		RoomID: "room-1", Name: "Room One", CreatedAt: domain.NowMillis(), TotalPage: 1,
	}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	exists, err = store.HasRoom(ctx, "room-1")
	if err != nil || !exists {
		t.Fatalf("expected the created room to exist, exists=%v err=%v", exists, err)
	}

	// A duplicate insert must fail, which is what createRoom maps to a 400.
	if err := store.CreateRoom(ctx, domain.Room{RoomID: "room-1", TotalPage: 1}); err == nil {
		t.Fatal("expected a duplicate room id to fail")
	}

	// Rooms created without a name or page count get defaults.
	if err := store.CreateRoom(ctx, domain.Room{RoomID: "room-2"}); err != nil {
		t.Fatalf("create room without defaults: %v", err)
	}
	room, exists, err := store.GetRoom(ctx, "room-2")
	if err != nil || !exists {
		t.Fatalf("get room: exists=%v err=%v", exists, err)
	}
	if room.Name == "" || room.TotalPage != 1 || room.CreatedAt == 0 {
		t.Fatalf("expected defaulted room metadata, got %+v", room)
	}

	generated, err := store.GenerateRoomID(ctx)
	if err != nil {
		t.Fatalf("generate room id: %v", err)
	}
	if !regexp.MustCompile(`^\d{6}$`).MatchString(generated) {
		t.Fatalf("expected a six-digit generated room id, got %q", generated)
	}
}

func TestReadyFailsAfterClose(t *testing.T) {
	store := openTestStore(t)
	if err := store.Ready(context.Background()); err != nil {
		t.Fatalf("ready before close: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := store.Ready(context.Background()); err == nil {
		t.Fatal("expected readiness to fail once the database is closed")
	}
}
