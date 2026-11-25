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

func testConfig(t *testing.T) config.Config {
	t.Helper()
	cfg := config.Config{
		DBPath:                 filepath.Join(t.TempDir(), "test.sqlite"),
		RoomReliableQueue:      64,
		RoomRealtimeQueue:      64,
		ConnectionSendMessages: 64,
		DBBatchSize:            16,
		DBBatchWindow:          time.Millisecond,
		InitCommandChunkSize:   100,
		InitFlatPointChunkSize: 2000,
		InitPreloadPageCount:   2,
		PageCacheRadius:        1,
		WALCheckpointInterval:  time.Hour,
		WALCheckpointBytes:     1 << 30,
		WALTruncateBytes:       1 << 31,
	}
	return cfg
}

func newTestStore(t *testing.T, cfg config.Config) *storage.Store {
	t.Helper()
	store, err := storage.Open(cfg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.CreateRoom(context.Background(), domain.Room{
		RoomID: "room-1", Name: "room-1", CreatedAt: domain.NowMillis(), TotalPage: 1,
	}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	return store
}

func TestRegistryGetReturnsSameActor(t *testing.T) {
	cfg := testConfig(t)
	registry := NewRegistry(newTestStore(t, cfg), cfg)
	t.Cleanup(func() { registry.Shutdown(context.Background()) })

	first, err := registry.Get(context.Background(), "room-1")
	if err != nil {
		t.Fatalf("first get: %v", err)
	}
	second, err := registry.Get(context.Background(), "room-1")
	if err != nil {
		t.Fatalf("second get: %v", err)
	}
	if first != second {
		t.Fatal("expected repeated lookups to share one actor")
	}
}

func TestRegistryGetUnknownRoom(t *testing.T) {
	cfg := testConfig(t)
	registry := NewRegistry(newTestStore(t, cfg), cfg)
	t.Cleanup(func() { registry.Shutdown(context.Background()) })

	if _, err := registry.Get(context.Background(), "does-not-exist"); err == nil {
		t.Fatal("expected an error for a room that does not exist")
	}
}

func TestDeletedRoomGetsFreshActorWhenRecreated(t *testing.T) {
	ctx := context.Background()
	cfg := testConfig(t)
	store := newTestStore(t, cfg)
	registry := NewRegistry(store, cfg)
	t.Cleanup(func() { registry.Shutdown(ctx) })
	old, err := registry.Get(ctx, "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Delete(ctx, "room-1"); err != nil {
		t.Fatal(err)
	}
	if !old.Stopped() {
		t.Fatal("old actor remained active")
	}
	if err := store.CreateRoom(ctx, domain.Room{RoomID: "room-1", Name: "new-room", CreatedAt: domain.NowMillis() + 1000, TotalPage: 1}); err != nil {
		t.Fatal(err)
	}
	fresh, err := registry.Get(ctx, "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if fresh == old || fresh.state.Room.Name != "new-room" {
		t.Fatal("recreated room reused old state")
	}
}

func TestRegistryRejectsLoadsDuringDeletion(t *testing.T) {
	cfg := testConfig(t)
	registry := NewRegistry(newTestStore(t, cfg), cfg)
	registry.deleting["room-1"] = true
	if _, err := registry.Get(context.Background(), "room-1"); err != ErrActorStopped {
		t.Fatalf("got %v", err)
	}
}

func TestJoinRejectsGuestRevokedWhileQueued(t *testing.T) {
	cfg := testConfig(t)
	store := newTestStore(t, cfg)
	ctx := context.Background()
	if err := store.CreateGuest(ctx, "room-1", "guest", "editor"); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry(store, cfg)
	t.Cleanup(func() { registry.Shutdown(ctx) })
	actor, err := registry.Get(ctx, "room-1")
	if err != nil {
		t.Fatal(err)
	}
	// The socket passed its gateway check, then the guest was kicked before the
	// actor processed the already queued join.
	if err := store.UpdateGuest(ctx, "room-1", "owner", "guest", "kick"); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	defer close(done)
	_, err = actor.Join(ClientInfo{ID: "stale", UserID: "guest", Send: make(chan Outbound, 64), Done: done}, 0, 0)
	if err == nil {
		t.Fatal("revoked guest joined through an already queued request")
	}
}

// TestRegistryReplacesStoppedActor is the regression test for the eviction bug:
// a stopped actor used to stay in the registry map, so every later join was
// handed a dead actor, blocked forever waiting for a reply that could not come,
// and leaked its goroutine plus a connection-limiter slot. A room left empty
// past the idle timeout became permanently unjoinable.
func TestRegistryReplacesStoppedActor(t *testing.T) {
	cfg := testConfig(t)
	registry := NewRegistry(newTestStore(t, cfg), cfg)
	t.Cleanup(func() { registry.Shutdown(context.Background()) })

	stopped, err := registry.Get(context.Background(), "room-1")
	if err != nil {
		t.Fatalf("initial get: %v", err)
	}

	// Force the actor to exit the way idle eviction does.
	stopped.Shutdown(context.Background())
	waitForStopped(t, stopped)

	replacement, err := registry.Get(context.Background(), "room-1")
	if err != nil {
		t.Fatalf("get after stop: %v", err)
	}
	if replacement == stopped {
		t.Fatal("expected a fresh actor after the previous one stopped")
	}
	if replacement.Stopped() {
		t.Fatal("expected the replacement actor to be running")
	}

	// And it must actually serve traffic rather than hang.
	result, err := replacement.Join(testClientInfo(), 0, 0)
	if err != nil {
		t.Fatalf("join replacement: %v", err)
	}
	if result.Room.RoomID != "room-1" {
		t.Fatalf("unexpected join result: %+v", result.Room)
	}
}

// TestJoinOnStoppedActorFailsFast pins the other half of the fix: requests
// against a stopped actor must return an error instead of blocking forever.
func TestJoinOnStoppedActorFailsFast(t *testing.T) {
	cfg := testConfig(t)
	registry := NewRegistry(newTestStore(t, cfg), cfg)
	t.Cleanup(func() { registry.Shutdown(context.Background()) })

	actor, err := registry.Get(context.Background(), "room-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	actor.Shutdown(context.Background())
	waitForStopped(t, actor)

	done := make(chan error, 1)
	go func() {
		_, joinErr := actor.Join(testClientInfo(), 0, 0)
		done <- joinErr
	}()

	select {
	case joinErr := <-done:
		if joinErr == nil {
			t.Fatal("expected joining a stopped actor to fail")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Join blocked on a stopped actor instead of returning an error")
	}

	if _, err := actor.PageReview(); err == nil {
		t.Fatal("expected PageReview on a stopped actor to fail")
	}
	if _, err := actor.Snapshot(0); err == nil {
		t.Fatal("expected Snapshot on a stopped actor to fail")
	}
}

func TestRegistryStatsExcludesStoppedActors(t *testing.T) {
	cfg := testConfig(t)
	registry := NewRegistry(newTestStore(t, cfg), cfg)
	t.Cleanup(func() { registry.Shutdown(context.Background()) })

	actor, err := registry.Get(context.Background(), "room-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(registry.Stats()) != 1 {
		t.Fatalf("expected one live room in stats, got %d", len(registry.Stats()))
	}

	actor.Shutdown(context.Background())
	waitForStopped(t, actor)
	// lookup drops the stale entry; Stats must not keep reporting dead rooms.
	registry.lookup("room-1")

	if stats := registry.Stats(); len(stats) != 0 {
		t.Fatalf("expected stopped rooms to be dropped from stats, got %v", stats)
	}
}

func testClientInfo() ClientInfo {
	return ClientInfo{
		ID: ClientID("client-1"), UserID: "u1", UserName: "alice",
		Send: make(chan Outbound, 256),
	}
}

func TestSlowInitialSnapshotDoesNotBlockRoom(t *testing.T) {
	cfg := testConfig(t)
	store := newTestStore(t, cfg)
	if err := store.CreateGuest(context.Background(), "room-1", "u1", "editor"); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry(store, cfg)
	t.Cleanup(func() { registry.Shutdown(context.Background()) })
	actor, err := registry.Get(context.Background(), "room-1")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	defer close(done)
	client := testClientInfo()
	client.Send = make(chan Outbound, 1)
	client.Done = done
	if _, err = actor.Join(client, 0, 0); err != nil {
		t.Fatal(err)
	}
	reviewed := make(chan error, 1)
	go func() { _, err := actor.PageReview(); reviewed <- err }()
	select {
	case err := <-reviewed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("slow snapshot blocked room actor")
	}
}

func waitForStopped(t *testing.T, actor *Actor) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if actor.Stopped() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("actor did not stop in time")
}
