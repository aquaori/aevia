package storage

import (
	"context"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func TestReadSnapshotPinsCommittedVersion(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	if err := store.CreateRoom(ctx, domain.Room{RoomID: "snapshot", Name: "snapshot", CreatedAt: domain.NowMillis(), TotalPage: 1}); err != nil {
		t.Fatal(err)
	}
	first := domain.NewCommand(map[string]any{"id": "first", "pageId": 0, "type": "pen"})
	if err := store.SaveCommandAtSeq("snapshot", first, 1, true); err != nil {
		t.Fatal(err)
	}
	snapshot, seq, err := store.BeginReadSnapshot(ctx, "snapshot")
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	if seq != 1 {
		t.Fatalf("sequence = %d", seq)
	}
	second := domain.NewCommand(map[string]any{"id": "second", "pageId": 0, "type": "pen"})
	if err := store.SaveCommandAtSeq("snapshot", second, 2, true); err != nil {
		t.Fatal(err)
	}
	commands, err := snapshot.Commands(ctx)
	if err != nil || len(commands) != 1 || commands[0].ID() != "first" {
		t.Fatalf("snapshot: %+v %v", commands, err)
	}
	selected, err := snapshot.CommandsByID(ctx, []string{"first", "second"})
	if err != nil || len(selected) != 1 || selected[0].ID() != "first" {
		t.Fatalf("selected snapshot: %+v %v", selected, err)
	}
}
