package storage

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func TestAPGStateWriteRequiresRoomRole(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	const roomID = "apg-auth-room"

	owner := Account{ID: "acc-apg-owner", Username: "apg-owner", Nickname: "Owner"}
	editor := Account{ID: "acc-apg-editor", Username: "apg-editor", Nickname: "Editor"}
	viewer := Account{ID: "acc-apg-viewer", Username: "apg-viewer", Nickname: "Viewer"}
	outsider := Account{ID: "acc-apg-outsider", Username: "apg-outsider", Nickname: "Outsider"}
	for _, account := range []Account{owner, editor, viewer, outsider} {
		if err := store.CreateAccount(ctx, account, "pw-hash"); err != nil {
			t.Fatalf("create %s: %v", account.Username, err)
		}
	}
	if err := store.CreateOwnedRoom(ctx, domain.Room{RoomID: roomID, Name: "APG"}, owner.ID); err != nil {
		t.Fatalf("create room: %v", err)
	}
	for _, account := range []Account{editor, viewer} {
		if err := store.JoinAccountRoom(ctx, roomID, account.ID); err != nil {
			t.Fatalf("join %s: %v", account.Username, err)
		}
	}
	if err := store.UpdateMember(ctx, roomID, owner.ID, editor.ID, "editor"); err != nil {
		t.Fatalf("promote editor: %v", err)
	}
	if err := store.UpdateMember(ctx, roomID, owner.ID, viewer.ID, "viewer"); err != nil {
		t.Fatalf("demote viewer: %v", err)
	}
	if err := store.CreateGuest(ctx, roomID, "guest-editor", "editor"); err != nil {
		t.Fatalf("create guest editor: %v", err)
	}
	if err := store.CreateGuest(ctx, roomID, "guest-viewer", "viewer"); err != nil {
		t.Fatalf("create guest viewer: %v", err)
	}

	write := func(actorID string, account bool, expected int64, value int) (bool, error) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return store.WriteAPGStateAuthorized(ctx, roomID, "aevia.counter", actorID, account, expected, 0, raw)
	}
	assertDenied := func(actorID string, account bool, expected int64) {
		t.Helper()
		if _, err := write(actorID, account, expected, 99); !errors.Is(err, ErrAPGWriteUnauthorized) {
			t.Fatalf("%s write error = %v, want %v", actorID, err, ErrAPGWriteUnauthorized)
		}
		state, err := store.ReadAPGState(ctx, roomID, "aevia.counter")
		if err != nil {
			t.Fatal(err)
		}
		if state.Revision != expected {
			t.Fatalf("denied write changed revision: %d want %d", state.Revision, expected)
		}
	}

	// Viewer and non-member writes are denied even without the HTTP role pre-check.
	assertDenied(viewer.ID, true, 0)
	assertDenied(outsider.ID, true, 0)
	assertDenied("guest-viewer", false, 0)

	changed, err := write(editor.ID, true, 0, 1)
	if err != nil || !changed {
		t.Fatalf("editor write: changed=%v err=%v", changed, err)
	}
	if _, err := write(editor.ID, true, 0, 2); !errors.Is(err, ErrAPGStateConflict) {
		t.Fatalf("stale write error = %v, want %v", err, ErrAPGStateConflict)
	}
	changed, err = write("guest-editor", false, 1, 3)
	if err != nil || !changed {
		t.Fatalf("guest editor write: changed=%v err=%v", changed, err)
	}
	state, err := store.ReadAPGState(ctx, roomID, "aevia.counter")
	if err != nil {
		t.Fatal(err)
	}
	if state.Revision != 2 || string(state.Value) != "3" {
		t.Fatalf("state = %+v", state)
	}
}

func TestAPGStateConcurrentWritersHaveSingleWinner(t *testing.T) {
	// Mirror production settings: without a busy timeout, SQLite returns
	// SQLITE_BUSY instead of letting the CAS predicate decide the winner.
	cfg := testStoreConfig(t)
	cfg.DBBusyTimeout = 15 * time.Second
	store, err := Open(cfg)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()
	const roomID = "apg-race-room"
	const pluginID = "aevia.counter"

	owner := Account{ID: "acc-apg-race", Username: "apg-race", Nickname: "Race"}
	if err := store.CreateAccount(ctx, owner, "pw-hash"); err != nil {
		t.Fatalf("create account: %v", err)
	}
	if err := store.CreateOwnedRoom(ctx, domain.Room{RoomID: roomID, Name: "Race"}, owner.ID); err != nil {
		t.Fatalf("create room: %v", err)
	}

	round := func(expected int64, writers int, wantRevision int64) int64 {
		t.Helper()
		start := make(chan struct{})
		var wg sync.WaitGroup
		var mu sync.Mutex
		winners := int64(0)
		conflicts := 0
		errs := make([]error, 0, writers)
		for i := 0; i < writers; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				raw, err := json.Marshal(i + 1)
				if err != nil {
					mu.Lock()
					errs = append(errs, err)
					mu.Unlock()
					return
				}
				<-start
				changed, err := store.WriteAPGStateAuthorized(ctx, roomID, pluginID, owner.ID, true, expected, 0, raw)
				mu.Lock()
				defer mu.Unlock()
				switch {
				case err == nil && changed:
					winners++
				case errors.Is(err, ErrAPGStateConflict):
					conflicts++
				default:
					errs = append(errs, err)
				}
			}(i)
		}
		close(start)
		wg.Wait()
		if len(errs) != 0 {
			t.Fatalf("unexpected errors: %v", errs)
		}
		if winners != 1 {
			t.Fatalf("round expected=%d: %d winners, want exactly 1", expected, winners)
		}
		if conflicts != writers-1 {
			t.Fatalf("round expected=%d: %d conflicts, want %d", expected, conflicts, writers-1)
		}
		state, err := store.ReadAPGState(ctx, roomID, pluginID)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if state.Revision != int64(wantRevision) {
			t.Fatalf("revision = %d, want %d", state.Revision, wantRevision)
		}
		return state.Revision
	}

	round(0, 8, 1)
	round(1, 8, 2)
}

func TestAPGStateSurvivesRestartAndKeepsRevision(t *testing.T) {
	cfg := testStoreConfig(t)
	ctx := context.Background()
	const roomID = "apg-restart-room"
	const pluginID = "aevia.counter"
	owner := Account{ID: "acc-apg-restart", Username: "apg-restart", Nickname: "Restart"}

	first, err := Open(cfg)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := first.CreateAccount(ctx, owner, "pw-hash"); err != nil {
		t.Fatalf("create account: %v", err)
	}
	if err := first.CreateOwnedRoom(ctx, domain.Room{RoomID: roomID, Name: "Restart"}, owner.ID); err != nil {
		t.Fatalf("create room: %v", err)
	}
	if changed, err := first.WriteAPGStateAuthorized(ctx, roomID, pluginID, owner.ID, true, 0, 0, json.RawMessage("7")); err != nil || !changed {
		t.Fatalf("seed write: changed=%v err=%v", changed, err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	second, err := Open(cfg)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer second.Close()
	state, err := second.ReadAPGState(ctx, roomID, pluginID)
	if err != nil {
		t.Fatalf("read after restart: %v", err)
	}
	if state.Revision != 1 || string(state.Value) != "7" {
		t.Fatalf("state after restart = %+v", state)
	}
	// A client that reconnects with the pre-restart revision must not win.
	if _, err := second.WriteAPGStateAuthorized(ctx, roomID, pluginID, owner.ID, true, 0, 0, json.RawMessage("8")); !errors.Is(err, ErrAPGStateConflict) {
		t.Fatalf("stale write after restart error = %v, want %v", err, ErrAPGStateConflict)
	}
	if changed, err := second.WriteAPGStateAuthorized(ctx, roomID, pluginID, owner.ID, true, 1, 0, json.RawMessage("8")); err != nil || !changed {
		t.Fatalf("increment after restart: changed=%v err=%v", changed, err)
	}
}

func TestAPGStateSchemaVersionGuardsAgainstDowngrade(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	const roomID = "apg-schema-room"
	owner := Account{ID: "acc-apg-schema-owner", Username: "apg-schema-owner", Nickname: "Owner"}
	if err := store.CreateAccount(ctx, owner, "pw-hash"); err != nil {
		t.Fatalf("create owner: %v", err)
	}
	if err := store.CreateOwnedRoom(ctx, domain.Room{RoomID: roomID, Name: "APG schema"}, owner.ID); err != nil {
		t.Fatalf("create room: %v", err)
	}

	if changed, err := store.WriteAPGStateAuthorized(ctx, roomID, "aevia.counter", owner.ID, true, 0, 2, json.RawMessage(`{"v":2}`)); err != nil || !changed {
		t.Fatalf("v2 write: changed=%v err=%v", changed, err)
	}
	state, err := store.ReadAPGState(ctx, roomID, "aevia.counter")
	if err != nil {
		t.Fatal(err)
	}
	if state.SchemaVersion != 2 || state.Revision != 1 {
		t.Fatalf("stored state: %+v", state)
	}
	// Same schema keeps working.
	if changed, err := store.WriteAPGStateAuthorized(ctx, roomID, "aevia.counter", owner.ID, true, 1, 2, json.RawMessage(`{"v":3}`)); err != nil || !changed {
		t.Fatalf("v2 rewrite: changed=%v err=%v", changed, err)
	}
	// An older package (schema 1, or a plugin that predates versioning) cannot overwrite it.
	if _, err := store.WriteAPGStateAuthorized(ctx, roomID, "aevia.counter", owner.ID, true, 2, 1, json.RawMessage(`{"v":1}`)); !errors.Is(err, ErrAPGStateSchemaConflict) {
		t.Fatalf("expected schema conflict, got %v", err)
	}
	if _, err := store.WriteAPGStateAuthorized(ctx, roomID, "aevia.counter", owner.ID, true, 2, 0, json.RawMessage(`{"v":0}`)); !errors.Is(err, ErrAPGStateSchemaConflict) {
		t.Fatalf("expected schema conflict for unversioned writer, got %v", err)
	}
	state, err = store.ReadAPGState(ctx, roomID, "aevia.counter")
	if err != nil || state.Revision != 2 || state.SchemaVersion != 2 {
		t.Fatalf("state changed by rejected writes: %+v err=%v", state, err)
	}
}
