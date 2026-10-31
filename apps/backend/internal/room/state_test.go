package room

import (
	"testing"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func stateTestPathCommand(id string, lamport float64, pageID int, points ...domain.Point) domain.Command {
	return domain.NewCommand(map[string]any{
		"id":        id,
		"type":      "path",
		"tool":      "pen",
		"color":     "#111111",
		"size":      3.0,
		"userId":    "user-1",
		"pageId":    pageID,
		"lamport":   lamport,
		"isDeleted": false,
		"points":    points,
	})
}

func stateTestSceneOperation(id, kind string, pageID int, historyGroupID string, before map[string]any) domain.Command {
	operation := map[string]any{
		"opId":      id,
		"kind":      kind,
		"pageId":    pageID,
		"elementId": "element-1",
		"actorId":   "user-1",
		"roomId":    "room-1",
		"lamport":   1.0,
	}
	if historyGroupID != "" {
		operation["historyGroupId"] = historyGroupID
	}
	if kind == "history.toggle" {
		operation["payload"] = map[string]any{"targetHistoryGroupId": historyGroupID, "enabled": false}
	}
	if kind == "page.clear" {
		operation["payload"] = map[string]any{"before": before}
	}
	return domain.NewCommand(map[string]any{
		"id": id, "type": "scene-op", "userId": "user-1", "pageId": pageID,
		"sceneOperation": operation,
	})
}

func stateTestRoom(durableSeq uint64, totalPage int) domain.Room {
	return domain.Room{RoomID: "room-1", Name: "Room", CreatedAt: 1, TotalPage: totalPage, DurableSeq: durableSeq}
}

func TestNewStateIndexesCommandsAndSeedsSequence(t *testing.T) {
	commands := []domain.Command{
		stateTestPathCommand("cmd-a", 1, 0,
			domain.Point{X: 0.1, Y: 0.1, P: 0.5, Lamport: 1},
			domain.Point{X: 0.2, Y: 0.2, P: 0.5, Lamport: 2},
		),
		stateTestPathCommand("cmd-b", 2, 1, domain.Point{X: 0.3, Y: 0.3, P: 0.5, Lamport: 3}),
	}

	state := NewState(stateTestRoom(41, 2), commands)

	if state.RoomSeq != 41 {
		t.Fatalf("expected room sequence seeded from DurableSeq 41, got %d", state.RoomSeq)
	}
	if got := state.NextRoomSeq(); got != 42 {
		t.Fatalf("expected NextRoomSeq 42, got %d", got)
	}
	if len(state.Commands) != 2 {
		t.Fatalf("expected 2 commands, got %d", len(state.Commands))
	}
	if got := state.Index.PagePointCount([]int{0}); got != 2 {
		t.Fatalf("expected 2 indexed points on page 0, got %d", got)
	}
	if got := state.Index.PagePointCount([]int{1}); got != 1 {
		t.Fatalf("expected 1 indexed point on page 1, got %d", got)
	}
	if state.Index.PagePointCount([]int{0, 1}) != 3 {
		t.Fatal("expected the page point index to cover both pages")
	}
}

func TestStateUpsertAndDeleteKeepIndexInSync(t *testing.T) {
	state := NewState(stateTestRoom(0, 1), nil)
	command := stateTestPathCommand("cmd-a", 1, 0,
		domain.Point{X: 0.1, Y: 0.1, P: 0.5, Lamport: 1},
	)

	state.UpsertCommand(command)
	if _, ok := state.Commands["cmd-a"]; !ok {
		t.Fatal("expected UpsertCommand to register the command")
	}
	if got := state.Index.PagePointCount([]int{0}); got != 1 {
		t.Fatalf("expected 1 indexed point after upsert, got %d", got)
	}

	// The stored command is a snapshot: mutating the caller's copy must not
	// change room state.
	command.SetPoints([]domain.Point{{X: 0.9, Y: 0.9, P: 0.5, Lamport: 1}})
	if got := len(state.Commands["cmd-a"].Points()); got != 1 {
		t.Fatalf("expected the stored command to keep its snapshot points, got %d", got)
	}
	if state.Commands["cmd-a"].Points()[0].X != 0.1 {
		t.Fatal("expected the snapshot point coordinates to be preserved")
	}

	if deleted := state.DeleteCommand("cmd-a"); !deleted {
		t.Fatal("expected DeleteCommand to report a deletion")
	}
	if len(state.Commands) != 0 {
		t.Fatalf("expected no commands after delete, got %d", len(state.Commands))
	}
	if got := state.Index.PagePointCount([]int{0}); got != 0 {
		t.Fatalf("expected the index to drop deleted points, got %d", got)
	}
	if deleted := state.DeleteCommand("cmd-a"); deleted {
		t.Fatal("expected deleting an unknown command to report false")
	}
}

func TestStateClearWatermarksTrackLatestPageClear(t *testing.T) {
	early := stateTestSceneOperation("clear-early", "page.clear", 0, "group-early", map[string]any{
		"lamport": 5.0, "opId": "op-5", "sourceIndex": 0, "subIndex": 0,
	})
	late := stateTestSceneOperation("clear-late", "page.clear", 0, "group-late", map[string]any{
		"lamport": 9.0, "opId": "op-9", "sourceIndex": 2, "subIndex": 4,
	})
	otherPage := stateTestSceneOperation("clear-page-1", "page.clear", 1, "group-page-1", map[string]any{
		"lamport": 7.0, "opId": "op-7", "sourceIndex": 0, "subIndex": 0,
	})

	state := NewState(stateTestRoom(0, 2), []domain.Command{late, early, otherPage})

	watermark, ok := state.ClearBefore[0]
	if !ok {
		t.Fatal("expected a clear watermark for page 0")
	}
	if watermark.Lamport != 9 || watermark.OpID != "op-9" || watermark.SourceIndex != 2 || watermark.SubIndex != 4 {
		t.Fatalf("expected the latest page clear to win, got %+v", watermark)
	}
	if state.ClearBefore[1].OpID != "op-7" {
		t.Fatalf("expected an independent watermark for page 1, got %+v", state.ClearBefore[1])
	}

	// Removing the latest clear must rebuild the watermark from what remains.
	state.DeleteCommand("clear-late")
	if state.ClearBefore[0].OpID != "op-5" {
		t.Fatalf("expected the earlier page clear to become the watermark, got %+v", state.ClearBefore[0])
	}
}

func TestStateClearWatermarkRespectsDisabledHistoryGroups(t *testing.T) {
	clear := stateTestSceneOperation("clear-1", "page.clear", 0, "group-a", map[string]any{
		"lamport": 3.0, "opId": "op-3", "sourceIndex": 0, "subIndex": 0,
	})
	toggleOff := stateTestSceneOperation("toggle-off", "history.toggle", 0, "group-a", nil)

	state := NewState(stateTestRoom(0, 1), []domain.Command{clear, toggleOff})
	if _, ok := state.ClearBefore[0]; ok {
		t.Fatalf("a disabled history group must not contribute a clear watermark, got %+v", state.ClearBefore[0])
	}

	// Removing the toggle re-enables the group, which must restore the watermark.
	if !state.DeleteCommand("toggle-off") {
		t.Fatal("expected the toggle command to be deleted")
	}
	if state.ClearBefore[0].OpID != "op-3" {
		t.Fatalf("expected the re-enabled clear to restore the watermark, got %+v", state.ClearBefore[0])
	}
}

func TestStateClearHandlesSinglePageAndFullReset(t *testing.T) {
	pageZero := stateTestPathCommand("cmd-p0", 1, 0, domain.Point{X: 0.1, Y: 0.1, P: 0.5, Lamport: 1})
	pageOne := stateTestPathCommand("cmd-p1", 2, 1, domain.Point{X: 0.2, Y: 0.2, P: 0.5, Lamport: 2})
	clear := stateTestSceneOperation("clear-1", "page.clear", 0, "group-a", map[string]any{
		"lamport": 3.0, "opId": "op-3", "sourceIndex": 0, "subIndex": 0,
	})
	state := NewState(stateTestRoom(0, 2), []domain.Command{pageZero, pageOne, clear})

	pageZeroID := 0
	state.Clear(&pageZeroID)
	if _, ok := state.Commands["cmd-p0"]; ok {
		t.Fatal("expected page 0 commands to be cleared")
	}
	if _, ok := state.Commands["cmd-p1"]; !ok {
		t.Fatal("expected page 1 commands to survive a single-page clear")
	}
	if _, ok := state.ClearBefore[0]; ok {
		t.Fatal("expected the page 0 clear watermark to be dropped")
	}
	if state.Index.PagePointCount([]int{0}) != 0 {
		t.Fatal("expected the page 0 index to be empty after clear")
	}

	state.Clear(nil)
	if len(state.Commands) != 0 || len(state.ClearBefore) != 0 {
		t.Fatalf("expected a full reset to drop commands and watermarks, got %d commands",
			len(state.Commands))
	}
	if state.Index.PagePointCount([]int{1}) != 0 {
		t.Fatal("expected a full reset to clear every page index")
	}
}

func TestStatePageReviewAndOnlineMembers(t *testing.T) {
	state := NewState(stateTestRoom(0, 3), nil)
	state.Clients = map[ClientID]ClientInfo{
		"c1": {ID: "c1", UserID: "u1", UserName: "Ann", PageID: 1},
		// A second tab for the same user must not duplicate the member list but
		// must still count as a collaborator on its page.
		"c2": {ID: "c2", UserID: "u1", UserName: "Ann", PageID: 2},
		"c3": {ID: "c3", UserID: "u2", UserName: "Bob", PageID: 1},
		"c4": {ID: "c4", UserID: "u3", UserName: "Cara", PageID: 99},
	}

	review := state.PageReview()
	if review.RoomID != "room-1" || review.TotalPage != 3 || len(review.Pages) != 3 {
		t.Fatalf("unexpected page review envelope: %+v", review)
	}
	if review.Pages[1].CollaboratorCount != 2 {
		t.Fatalf("expected 2 collaborators on page 1, got %d", review.Pages[1].CollaboratorCount)
	}
	// Out-of-range client pages are normalized to the last page, not dropped.
	if review.Pages[2].CollaboratorCount != 2 {
		t.Fatalf("expected out-of-range pages to normalize to the last page, got %+v", review.Pages[2])
	}

	members := state.OnlineMembers()
	if len(members) != 3 {
		t.Fatalf("expected 3 unique online members, got %d: %v", len(members), members)
	}
	seen := map[string]bool{}
	for _, member := range members {
		seen[member[0]] = true
	}
	if !seen["u1"] || !seen["u2"] || !seen["u3"] {
		t.Fatalf("expected every user id in the member list, got %v", members)
	}
}
