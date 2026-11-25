package room

import (
	"bytes"
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

func TestDeltaReplayPreservesBinaryUpdates(t *testing.T) {
	actor := &Actor{state: State{Deltas: NewDeltaBuffer(time.Minute, 1<<20)}}
	frame := []byte{1, 2, 3, 4}
	actor.recordAndBroadcast("", "push-cmd", map[string]any{"roomSeq": 1}, nil, frame)
	frame[0] = 9 // The retained delta must not share the caller's buffer.
	deltas, complete := actor.state.Deltas.Since(0)
	if !complete || len(deltas) != 1 {
		t.Fatalf("got %d deltas (complete=%v), want 1", len(deltas), complete)
	}
	queue := make(chan Outbound, 3)
	sendDeltaReplay(&streamSender{out: queue}, JoinResult{Deltas: deltas})
	<-queue // metadata
	if got := (<-queue).Binary; !bytes.Equal(got, []byte{1, 2, 3, 4}) {
		t.Fatalf("replayed binary frame %v", got)
	}
	if got := (<-queue).JSON.(Envelope).Type; got != "delta-replay-complete" {
		t.Fatalf("got %q after replay", got)
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

func TestDeltaReplayPreservesPushTypes(t *testing.T) {
	queue := make(chan Outbound, 8)
	actor := &Actor{state: State{Deltas: NewDeltaBuffer(time.Minute, 1<<20)}}
	for i, pushType := range []string{"normal", "update", "stop"} {
		data := map[string]any{"roomSeq": i + 1, "id": pushType}
		actor.recordAndBroadcast("", "push-cmd", data, Envelope{Type: "push-cmd", PushType: pushType, Data: data}, nil)
	}
	deltas, complete := actor.state.Deltas.Since(0)
	if !complete || len(deltas) != 3 {
		t.Fatalf("got %d deltas (complete=%v), want 3", len(deltas), complete)
	}
	result := JoinResult{Deltas: deltas}
	sendDeltaReplay(&streamSender{out: queue}, result)
	if got := (<-queue).JSON.(Envelope).Type; got != "delta-replay-meta" {
		t.Fatalf("got %q before replay", got)
	}
	for _, want := range []string{"normal", "update", "stop"} {
		got := (<-queue).JSON.(Envelope)
		if got.Type != "push-cmd" || got.PushType != want {
			t.Fatalf("got replay envelope %+v, want pushType %q", got, want)
		}
	}
	if got := (<-queue).JSON.(Envelope).Type; got != "delta-replay-complete" {
		t.Fatalf("got %q after replay", got)
	}
}
