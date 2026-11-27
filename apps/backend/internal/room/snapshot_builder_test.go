package room

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/domain"
	"collaborative-whiteboard/apps/backend/internal/protocol"
)

func TestInitSnapshotStateMatchesFullState(t *testing.T) {
	room := domain.Room{RoomID: "room", TotalPage: 1, DurableSeq: 12}
	commands := []domain.Command{
		stateTestPathCommand("old", 1, 0, domain.Point{X: 0.2, Y: 0.2, P: 0.5, Lamport: 1}),
		stateTestPathCommand("new", 3, 0, domain.Point{X: 0.8, Y: 0.8, P: 0.5, Lamport: 3}),
	}
	watermarks := map[int]sceneOrderKey{0: {Lamport: 2, OpID: "clear"}}
	full := NewState(room, commands)
	full.ClearBefore = watermarks
	minimal := newInitSnapshotState(room, commands, watermarks)
	builder := NewSnapshotBuilder(config.Config{InitPreloadPageCount: 1, InitCommandChunkSize: 32, InitFlatPointChunkSize: 512})
	want, got := builder.initDetached(full, 0), builder.initDetached(minimal, 0)
	want.CommandChunks, got.CommandChunks = want.prepareCommands(), got.prepareCommands()
	if want.SnapshotVersion != got.SnapshotVersion || !reflect.DeepEqual(want.Meta, got.Meta) ||
		!reflect.DeepEqual(want.RenderChunks, got.RenderChunks) || !reflect.DeepEqual(want.CommandChunks, got.CommandChunks) {
		t.Fatal("minimal initialization snapshot differs from full state")
	}
}

func TestDetachedInitUsesIndependentSnapshotCommands(t *testing.T) {
	live := domain.NewCommand(map[string]any{
		"id": "text", "type": "scene-op", "pageId": 0, "lamport": 1.0,
		"sceneOperation": map[string]any{"opId": "text", "elementId": "text", "kind": "text.patch", "payload": map[string]any{"value": "before"}},
	})
	detached := NewState(domain.Room{RoomID: "room", TotalPage: 1}, []domain.Command{live.Snapshot()})
	builder := NewSnapshotBuilder(config.Config{InitPreloadPageCount: 1, InitCommandChunkSize: 32, InitFlatPointChunkSize: 512})
	stream := builder.initDetached(detached, 0)
	stream.CommandChunks = stream.prepareCommands()
	live.Get("sceneOperation").(map[string]any)["payload"].(map[string]any)["value"] = "after"
	got := stream.CommandChunks[0].Commands[0].Get("sceneOperation").(map[string]any)["payload"].(map[string]any)["value"]
	if got != "before" {
		t.Fatalf("detached snapshot changed with live command: %v", got)
	}
}

func TestCapturedCommandsRemainStableAfterRoomUpdate(t *testing.T) {
	original := stateTestPathCommand("stroke", 1, 0, domain.Point{X: 0.2, Y: 0.2, P: 0.5, Lamport: 1})
	live := NewState(domain.Room{RoomID: "room", TotalPage: 1}, []domain.Command{original.Snapshot()})
	captured := live.Commands["stroke"]
	updated := captured.Clone()
	updated.SetPoints([]domain.Point{{X: 0.8, Y: 0.8, P: 0.5, Lamport: 2}})
	live.UpsertCommand(updated)
	builder := NewSnapshotBuilder(config.Config{InitPreloadPageCount: 1, InitCommandChunkSize: 32, InitFlatPointChunkSize: 512})
	stream := builder.initDetached(NewState(live.Room, []domain.Command{captured}), 0)
	stream.CommandChunks = stream.prepareCommands()
	got := stream.CommandChunks[0].Commands[0].Points()[0].X
	if got != 0.2 || live.Commands["stroke"].Points()[0].X != 0.8 {
		t.Fatalf("snapshot=%v live=%v", got, live.Commands["stroke"].Points()[0].X)
	}
}

func TestBackgroundHistoryLoadsClearedCommands(t *testing.T) {
	cfg := testConfig(t)
	store := newTestStore(t, cfg)
	old := stateTestPathCommand("old", 1, 0, domain.Point{X: 0.2, Y: 0.2, P: 0.5, Lamport: 1})
	clear := domain.NewCommand(map[string]any{"id": "clear", "type": "scene-op", "pageId": 0, "lamport": 2.0,
		"sceneOperation": map[string]any{"opId": "clear", "elementId": "page:0", "pageId": 0, "lamport": 2.0, "historyGroupId": "clear", "kind": "page.clear", "payload": map[string]any{"before": map[string]any{"lamport": 2.0, "opId": "clear"}}}})
	if err := store.SaveCommandAtSeq("room-1", old, 1, true); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCommandAtSeq("room-1", clear, 2, true); err != nil {
		t.Fatal(err)
	}
	actor := &Actor{roomID: "room-1", store: store, state: NewState(domain.Room{RoomID: "room-1", TotalPage: 1, DurableSeq: 2}, []domain.Command{old, clear})}
	out := make(chan Outbound, 8)
	done := make(chan struct{})
	defer close(done)
	actor.loadPageHistory(ClientInfo{PageID: 0, Send: out, Done: done}, map[string]any{"requestId": "r1", "pageId": 0})
	select {
	case event := <-out:
		if event.JSON.(Envelope).Type != "page-history-meta" {
			t.Fatal("missing history metadata")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("history metadata timed out")
	}
	select {
	case event := <-out:
		message := event.JSON.(Envelope)
		commands := message.Data["commands"].([]domain.Command)
		if message.Type != "page-history-chunk" || len(commands) != 1 || commands[0].ID() != "old" {
			t.Fatalf("unexpected history: %+v", message)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("history chunk timed out")
	}
	select {
	case event := <-out:
		if event.JSON.(Envelope).Type != "page-history-complete" {
			t.Fatal("missing completion")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("history completion timed out")
	}
	actor.loadPageHistory(ClientInfo{PageID: 0, Send: out, Done: done}, map[string]any{"requestId": "r2", "pageId": 0, "snapshotVersion": 2, "cursor": "old"})
	select {
	case event := <-out:
		meta := event.JSON.(Envelope)
		if meta.Type != "page-history-meta" || meta.Data["resumed"] != true {
			t.Fatalf("expected resumed metadata: %+v", meta)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("resumed metadata timed out")
	}
	select {
	case event := <-out:
		if event.JSON.(Envelope).Type != "page-history-complete" {
			t.Fatal("expected resumed stream to skip old command")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("resumed completion timed out")
	}
}

func TestEmptyHistoryCompletionWaitsForOutboundCapacity(t *testing.T) {
	actor := &Actor{state: State{}}
	out := make(chan Outbound, 1)
	done := make(chan struct{})
	defer close(done)
	actor.loadPageHistory(ClientInfo{PageID: 0, Send: out, Done: done}, map[string]any{"requestId": "history", "pageId": 0})
	if event := <-out; event.JSON.(Envelope).Type != "page-history-meta" {
		t.Fatal("missing history metadata")
	}
	select {
	case event := <-out:
		if event.JSON.(Envelope).Type != "page-history-complete" {
			t.Fatal("missing history completion")
		}
	case <-time.After(time.Second):
		t.Fatal("history completion was dropped")
	}
}

func TestCommandChunksBoundBytesAndPreserveOrder(t *testing.T) {
	commands := make([]domain.Command, 10)
	for index := range commands {
		commands[index] = domain.NewCommand(map[string]any{"id": string(rune('a' + index)), "data": strings.Repeat("x", 24000) + "<>&中文"})
	}
	chunks := chunkCommands(commands, 32)
	if len(chunks) < 4 {
		t.Fatalf("expected byte limit to split commands, got %d chunks", len(chunks))
	}
	var ids string
	for index, chunk := range chunks {
		if chunk.ChunkIndex != index || chunk.IsLast != (index == len(chunks)-1) {
			t.Fatal("incorrect chunk metadata")
		}
		original, err := json.Marshal(chunk.Commands)
		if err != nil {
			t.Fatal(err)
		}
		cached, err := json.Marshal(chunk.encoded)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(original, cached) {
			t.Fatal("cached commands changed the wire representation")
		}
		for _, command := range chunk.Commands {
			ids += command.ID()
		}
	}
	if ids != "abcdefghij" {
		t.Fatalf("commands were reordered: %q", ids)
	}
}

func TestInitSnapshotDoesNotReturnCommandsBeforeClearWatermark(t *testing.T) {
	pathCommand := func(id string, lamport float64) domain.Command {
		return domain.NewCommand(map[string]any{
			"id": id, "type": "scene-op", "userId": "user-1", "pageId": 0, "lamport": lamport,
			"sceneOperation": map[string]any{
				"opId": id, "elementId": id, "pageId": 0, "lamport": lamport,
				"historyGroupId": id, "kind": "element.create",
				"payload": map[string]any{
					"descriptor": map[string]any{
						"elementKind": "path", "recipeId": "stroke", "toolId": "pen",
						"style": map[string]any{"color": "#000", "size": 4.0},
					},
					"points": []any{map[string]any{"x": 0.2, "y": 0.2, "p": 0.5, "lamport": lamport}},
				},
			},
		})
	}

	before := pathCommand("before", 1)
	clear := domain.NewCommand(map[string]any{
		"id": "clear", "type": "scene-op", "userId": "user-1", "pageId": 0, "lamport": 2.0,
		"sceneOperation": map[string]any{
			"opId": "clear", "elementId": "page:0", "pageId": 0, "lamport": 2.0,
			"historyGroupId": "clear", "kind": "page.clear",
			"payload": map[string]any{"before": map[string]any{
				"lamport": 2.0, "opId": "clear", "sourceIndex": 0.0, "subIndex": 0.0,
			}},
		},
	})
	after := pathCommand("after", 3)
	lateAppend := domain.NewCommand(map[string]any{
		"id": "late-append", "type": "scene-op", "userId": "user-1", "pageId": 0, "lamport": 3.0,
		"sceneOperation": map[string]any{"opId": "late-append", "elementId": "before", "pageId": 0, "lamport": 3.0,
			"historyGroupId": "before", "kind": "element.append", "payload": map[string]any{"sourceStart": 1, "points": []any{map[string]any{"x": 0.3, "y": 0.3, "p": 0.5, "lamport": 3.0}}}},
	})
	state := NewState(domain.Room{RoomID: "room", TotalPage: 1}, []domain.Command{before, clear, after, lateAppend})
	if got := countCommandsForPages(state.Commands, []int{0}, state.ClearBefore); got != 2 {
		t.Fatalf("expected late append of cleared path to be excluded, got %d commands", got)
	}
	builder := NewSnapshotBuilder(config.Config{
		InitPreloadPageCount:   1,
		InitCommandChunkSize:   100,
		InitFlatPointChunkSize: 100,
	})

	stream := builder.Init(state, 0)
	if got := stream.Meta["maxLamport"]; got != 3.0 {
		t.Fatalf("expected max Lamport 3, got %#v", got)
	}
	if len(stream.RenderChunks) != 1 || len(stream.RenderChunks[0].Points) != 1 || stream.RenderChunks[0].Points[0].CmdID != "after" {
		t.Fatalf("expected only post-clear render points, got %+v", stream.RenderChunks)
	}
	if len(stream.CommandChunks) != 1 {
		t.Fatalf("expected one command chunk, got %d", len(stream.CommandChunks))
	}
	commands := stream.CommandChunks[0].Commands
	commandIDs := make([]string, 0, len(commands))
	for _, command := range commands {
		commandIDs = append(commandIDs, command.ID())
	}
	if len(commandIDs) != 2 || commandIDs[0] != "clear" || commandIDs[1] != "after" {
		t.Fatalf("expected clear marker and post-clear command only, got %v", commandIDs)
	}

	state.UpsertCommand(domain.NewCommand(map[string]any{
		"id": "undo-clear", "type": "scene-op", "userId": "user-1", "pageId": 0, "lamport": 4.0,
		"sceneOperation": map[string]any{
			"opId": "undo-clear", "elementId": "page:0", "pageId": 0, "lamport": 4.0,
			"historyGroupId": "undo-clear", "kind": "history.toggle",
			"payload": map[string]any{"targetHistoryGroupId": "clear", "enabled": false},
		},
	}))
	restored := builder.Init(state, 0)
	if len(restored.RenderChunks) != 1 || len(restored.RenderChunks[0].Points) != 3 {
		t.Fatalf("expected clear undo to restore pre-clear points, got %+v", restored.RenderChunks)
	}
	restoredIDs := make([]string, 0)
	for _, chunk := range restored.CommandChunks {
		for _, command := range chunk.Commands {
			restoredIDs = append(restoredIDs, command.ID())
		}
	}
	if len(restoredIDs) != 5 {
		t.Fatalf("expected clear undo snapshot to restore full command history, got %v", restoredIDs)
	}
}

func TestLiveInitStreamDoesNotBypassClearWatermark(t *testing.T) {
	pathCommand := func(id string, lamport float64) domain.Command {
		return domain.NewCommand(map[string]any{
			"id": id, "type": "path", "tool": "pen", "color": "#000", "size": 4.0,
			"userId": "user-1", "roomId": "room", "pageId": 0, "lamport": lamport,
			"points":    []any{map[string]any{"x": 0.2, "y": 0.2, "p": 0.5, "lamport": lamport}},
			"isDeleted": false,
		})
	}
	before := pathCommand("before", 1)
	clear := domain.NewCommand(map[string]any{
		"id": "clear", "type": "scene-op", "userId": "user-1", "pageId": 0, "lamport": 2.0,
		"sceneOperation": map[string]any{
			"opId": "clear", "elementId": "page:0", "pageId": 0, "lamport": 2.0,
			"historyGroupId": "clear", "kind": "page.clear",
			"payload": map[string]any{"before": map[string]any{
				"lamport": 2.0, "opId": "clear", "sourceIndex": 0.0, "subIndex": 0.0,
			}},
		},
	})
	after := pathCommand("after", 3)
	state := NewState(domain.Room{RoomID: "room", Name: "room", TotalPage: 1}, []domain.Command{before, clear, after})
	builder := NewSnapshotBuilder(config.Config{
		InitPreloadPageCount:   1,
		InitCommandChunkSize:   100,
		InitFlatPointChunkSize: 100,
	})
	outbound := make(chan Outbound, 16)
	builder.SendLiveInitStream(outbound, state, ClientInfo{UserID: "user-1", UserName: "user", PageID: 0}, 1, nil)

	var renderRefs []protocol.RenderCommandRef
	commandIDs := make([]string, 0)
	var maxLamport any
	for len(outbound) > 0 {
		message := <-outbound
		envelope, ok := message.JSON.(Envelope)
		if !ok {
			continue
		}
		switch envelope.Type {
		case "init-meta":
			maxLamport = envelope.Data["maxLamport"]
		case "init-render-chunk-meta":
			renderRefs, _ = envelope.Data["commands"].([]protocol.RenderCommandRef)
		case "init-commands-chunk":
			payload, err := json.Marshal(envelope.Data["commands"])
			if err != nil {
				t.Fatal(err)
			}
			var commands []domain.Command
			if err := json.Unmarshal(payload, &commands); err != nil {
				t.Fatal(err)
			}
			for _, command := range commands {
				commandIDs = append(commandIDs, command.ID())
			}
		}
	}
	if maxLamport != 3.0 {
		t.Fatalf("expected live init meta max Lamport 3, got %#v", maxLamport)
	}
	if len(renderRefs) != 1 || renderRefs[0].CmdID != "after" {
		t.Fatalf("expected live render stream to contain only post-clear points, got %+v", renderRefs)
	}
	if len(commandIDs) != 2 || commandIDs[0] != "clear" || commandIDs[1] != "after" {
		t.Fatalf("expected live command stream to contain clear and post-clear commands, got %v", commandIDs)
	}
}

func TestSnapshotCheckpointCacheHitsAndInvalidatesOnSeqOrClearChange(t *testing.T) {
	pathCommand := func(id string, lamport float64) domain.Command {
		return domain.NewCommand(map[string]any{
			"id": id, "type": "path", "tool": "pen", "color": "#000", "size": 4.0,
			"userId": "user-1", "roomId": "cache-room", "pageId": 0, "lamport": lamport,
			"points":    []any{map[string]any{"x": 0.2, "y": 0.2, "p": 0.5, "lamport": lamport}},
			"isDeleted": false,
		})
	}
	cmd1 := pathCommand("c1", 1)
	state := NewState(domain.Room{RoomID: "cache-room", Name: "Cache Room", TotalPage: 1, DurableSeq: 10}, []domain.Command{cmd1})
	builder := NewSnapshotBuilder(config.Config{InitPreloadPageCount: 1, InitCommandChunkSize: 32, InitFlatPointChunkSize: 512})

	first := builder.Init(state, 0)
	cached, ok := builder.TryCachedInit("cache-room", 0, 1, 10, state.ClearBefore)
	if !ok {
		t.Fatal("expected Init to populate checkpoint cache")
	}
	if cached.SnapshotVersion != first.SnapshotVersion || len(cached.RenderChunks) != len(first.RenderChunks) || len(cached.CommandChunks) != len(first.CommandChunks) {
		t.Fatalf("cached snapshot mismatch: got %+v vs %+v", cached, first)
	}

	// Sequence bump invalidates prior entry cleanly.
	cmd2 := pathCommand("c2", 2)
	state.RoomSeq = 11
	state.UpsertCommand(cmd2)
	if _, ok := builder.TryCachedInit("cache-room", 0, 1, 11, state.ClearBefore); ok {
		t.Fatal("expected cache miss on bumped roomSeq")
	}
	second := builder.Init(state, 0)
	if len(second.CommandChunks[0].Commands) != 2 {
		t.Fatalf("expected updated snapshot to include c2, got %d commands", len(second.CommandChunks[0].Commands))
	}
}
