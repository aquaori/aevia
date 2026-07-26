package storage

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"collaborative-whiteboard/apps/go-backend/internal/config"
	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

func testStoreConfig(t *testing.T) config.Config {
	t.Helper()
	return config.Config{
		DBPath:                filepath.Join(t.TempDir(), "writer.sqlite"),
		DBBatchSize:           16,
		DBBatchWindow:         time.Millisecond,
		WALCheckpointInterval: time.Hour,
		WALCheckpointBytes:    1 << 30,
		WALTruncateBytes:      1 << 31,
	}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(testStoreConfig(t))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func TestSessionEpochIsStableAcrossReopen(t *testing.T) {
	cfg := testStoreConfig(t)

	first, err := Open(cfg)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	epoch, err := first.SessionEpoch(context.Background())
	if err != nil {
		t.Fatalf("session epoch: %v", err)
	}
	if epoch <= 0 {
		t.Fatalf("expected a positive epoch, got %d", epoch)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// Reopening must not invalidate outstanding sessions: this is the whole point
	// of persisting the epoch rather than using process start time.
	second, err := Open(cfg)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer second.Close()

	reopened, err := second.SessionEpoch(context.Background())
	if err != nil {
		t.Fatalf("session epoch after reopen: %v", err)
	}
	if reopened != epoch {
		t.Fatalf("epoch changed across restart: %d -> %d", epoch, reopened)
	}
}

func TestBumpSessionEpochAdvances(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	before, err := store.SessionEpoch(ctx)
	if err != nil {
		t.Fatalf("session epoch: %v", err)
	}
	time.Sleep(1100 * time.Millisecond) // epoch has one-second resolution

	bumped, err := store.BumpSessionEpoch(ctx)
	if err != nil {
		t.Fatalf("bump: %v", err)
	}
	if bumped <= before {
		t.Fatalf("expected the epoch to advance, got %d after %d", bumped, before)
	}

	current, err := store.SessionEpoch(ctx)
	if err != nil {
		t.Fatalf("session epoch after bump: %v", err)
	}
	if current != bumped {
		t.Fatalf("expected the bumped epoch to persist, got %d want %d", current, bumped)
	}
}

func TestCommandPersistenceRoundTrip(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	if err := store.CreateRoom(ctx, domain.Room{
		RoomID: "r1", Name: "r1", CreatedAt: domain.NowMillis(), TotalPage: 1,
	}); err != nil {
		t.Fatalf("create room: %v", err)
	}

	cmd, err := domain.CommandFromPayload([]byte(`{"id":"c1","type":"path","tool":"pen","pageId":0,"lamport":5,"points":[{"x":1,"y":2,"p":1,"lamport":5}]}`))
	if err != nil {
		t.Fatalf("command payload: %v", err)
	}
	if err := store.SaveCommandAtSeq("r1", cmd, 7, true); err != nil {
		t.Fatalf("save: %v", err)
	}

	loaded, err := store.ListCommands(ctx, "r1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(loaded) != 1 || loaded[0].ID() != "c1" {
		t.Fatalf("unexpected commands: %+v", loaded)
	}

	room, ok, err := store.GetRoom(ctx, "r1")
	if err != nil || !ok {
		t.Fatalf("get room: ok=%v err=%v", ok, err)
	}
	if room.DurableSeq != 7 {
		t.Fatalf("expected durable_seq 7, got %d", room.DurableSeq)
	}

	if err := store.DeleteCommandAtSeq("r1", "c1", 8, true); err != nil {
		t.Fatalf("delete: %v", err)
	}
	remaining, err := store.ListCommands(ctx, "r1")
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("expected no commands after delete, got %d", len(remaining))
	}
}

// TestAsyncFailureHandlerIsInvoked pins the fix for silently-dropped
// fire-and-forget failures: an unwaited write that fails must reach the handler
// so the owning room can degrade instead of serving non-durable state.
func TestAsyncFailureHandlerIsInvoked(t *testing.T) {
	store := openTestStore(t)

	var (
		mu     sync.Mutex
		rooms  []string
		errsCh = make(chan struct{}, 1)
	)
	store.SetAsyncFailureHandler(func(roomID string, _ error) {
		mu.Lock()
		rooms = append(rooms, roomID)
		mu.Unlock()
		select {
		case errsCh <- struct{}{}:
		default:
		}
	})

	// No such room, and commands.room_id has a foreign key, so this write fails.
	cmd, err := domain.CommandFromPayload([]byte(`{"id":"c1","type":"path","pageId":0,"lamport":1}`))
	if err != nil {
		t.Fatalf("command payload: %v", err)
	}
	if err := store.SaveCommandAtSeq("missing-room", cmd, 1, false); err != nil {
		t.Fatalf("enqueue should succeed for an unwaited write: %v", err)
	}

	select {
	case <-errsCh:
	case <-time.After(3 * time.Second):
		t.Fatal("async write failure was never reported")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(rooms) == 0 || rooms[0] != "missing-room" {
		t.Fatalf("unexpected reported rooms: %v", rooms)
	}
}

func TestWaitedWriteReturnsError(t *testing.T) {
	store := openTestStore(t)

	cmd, err := domain.CommandFromPayload([]byte(`{"id":"c1","type":"path","pageId":0,"lamport":1}`))
	if err != nil {
		t.Fatalf("command payload: %v", err)
	}
	if err := store.SaveCommandAtSeq("missing-room", cmd, 1, true); err == nil {
		t.Fatal("expected a waited write against a missing room to return an error")
	}
}

func TestGenerateRoomIDIsUnusedAndWellFormed(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	id, err := store.GenerateRoomID(ctx)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(id) != 6 {
		t.Fatalf("expected a six-digit room id, got %q", id)
	}
	for _, c := range id {
		if c < '0' || c > '9' {
			t.Fatalf("expected digits only, got %q", id)
		}
	}
	exists, err := store.HasRoom(ctx, id)
	if err != nil {
		t.Fatalf("has room: %v", err)
	}
	if exists {
		t.Fatal("generated id should not already be in use")
	}
}
