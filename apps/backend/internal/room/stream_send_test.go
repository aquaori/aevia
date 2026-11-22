package room

import (
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func TestInitDefersCommandPreparationUntilAfterRenderStream(t *testing.T) {
	queue := make(chan Outbound, 16)
	preparedAfter := 0
	stream := InitStream{SnapshotVersion: 1, Meta: map[string]any{"pageId": 0, "loadedPageIds": []int{0}},
		prepareCommands: func() []CommandChunk {
			preparedAfter = len(queue)
			return chunkCommands([]domain.Command{domain.NewCommand(map[string]any{"id": "a", "pageId": 0})}, 32)
		},
	}
	sendInitStream(queue, "room", ClientInfo{Send: queue}, JoinResult{Room: domain.Room{RoomID: "room"}, Init: stream}, false)
	if preparedAfter != 3 {
		t.Fatalf("command preparation started after %d messages, want init meta and complete render stream", preparedAfter)
	}
	want := []string{"init-meta", "init-render-meta", "init-render-done", "init-commands-meta", "init-commands-chunk", "init-commands-done", "init-complete"}
	for _, kind := range want {
		if got := (<-queue).JSON.(Envelope).Type; got != kind {
			t.Fatalf("got %q, want %q", got, kind)
		}
	}
}

func TestPageStreamAbortsWhenQueueFills(t *testing.T) {
	queue := make(chan Outbound, 1)
	aborted := 0
	sendPageChangeStream(queue, func() { aborted++ }, InitStream{Meta: map[string]any{}})
	if aborted != 1 {
		t.Fatalf("expected one abort, got %d", aborted)
	}
	close(queue)
	for message := range queue {
		if envelope, ok := message.JSON.(Envelope); ok && envelope.Type == "page-change-complete" {
			t.Fatal("completed a failed stream")
		}
	}
}

func TestResumeDecision(t *testing.T) {
	buffer := NewDeltaBuffer(time.Minute, 1<<20)
	for _, scenario := range []struct {
		last, head uint64
		want       string
	}{{0, 0, "snapshot"}, {4, 4, "current"}, {3, 4, "snapshot"}, {5, 4, "snapshot"}} {
		if got, _ := decideResume(buffer, scenario.last, scenario.head); got != scenario.want {
			t.Fatalf("%+v: got %s", scenario, got)
		}
	}
	buffer.Add(DeltaEvent{RoomSeq: 4})
	if got, _ := decideResume(buffer, 3, 4); got != "delta" {
		t.Fatalf("expected delta, got %s", got)
	}
}
