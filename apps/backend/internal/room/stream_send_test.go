package room

import (
	"testing"
	"time"
)

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
