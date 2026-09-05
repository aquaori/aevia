package room

import (
	"testing"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/domain"
	"collaborative-whiteboard/apps/backend/internal/protocol"
)

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
	state := NewState(domain.Room{RoomID: "room", TotalPage: 1}, []domain.Command{before, clear, after})
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
	if len(restored.RenderChunks) != 1 || len(restored.RenderChunks[0].Points) != 2 {
		t.Fatalf("expected clear undo to restore pre-clear points, got %+v", restored.RenderChunks)
	}
	restoredIDs := make([]string, 0)
	for _, chunk := range restored.CommandChunks {
		for _, command := range chunk.Commands {
			restoredIDs = append(restoredIDs, command.ID())
		}
	}
	if len(restoredIDs) != 4 {
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
			commands, _ := envelope.Data["commands"].([]domain.Command)
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
