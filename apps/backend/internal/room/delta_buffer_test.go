package room

import (
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func deltaTestEvent(roomSeq uint64, payload map[string]any) DeltaEvent {
	return DeltaEvent{RoomSeq: roomSeq, Type: "cmd-start", Data: payload}
}

func TestDeltaBufferSinceReturnsOnlyNewerEvents(t *testing.T) {
	buffer := NewDeltaBuffer(time.Minute, 1<<20)
	buffer.Add(deltaTestEvent(1, map[string]any{"value": "a"}))
	buffer.Add(deltaTestEvent(2, map[string]any{"value": "b"}))
	buffer.Add(deltaTestEvent(3, map[string]any{"value": "c"}))

	all, ok := buffer.Since(0)
	if !ok || len(all) != 3 {
		t.Fatalf("expected all 3 events for seq 0, got ok=%v len=%d", ok, len(all))
	}
	if all[0].RoomSeq != 1 || all[2].RoomSeq != 3 {
		t.Fatalf("expected events in sequence order, got %+v", all)
	}

	newer, ok := buffer.Since(2)
	if !ok || len(newer) != 1 || newer[0].RoomSeq != 3 {
		t.Fatalf("expected only seq 3 after seq 2, got ok=%v %+v", ok, newer)
	}

	empty, ok := buffer.Since(3)
	if !ok || len(empty) != 0 {
		t.Fatalf("expected no events after the newest sequence, got ok=%v %+v", ok, empty)
	}
}

func TestDeltaBufferDetectsSequenceGap(t *testing.T) {
	buffer := NewDeltaBuffer(time.Minute, 1<<20)
	buffer.Add(deltaTestEvent(5, nil))
	buffer.Add(deltaTestEvent(6, nil))

	// The client is at seq 3 but the buffer's oldest event is 5, so seq 4 is
	// lost: replay must fall back to a snapshot instead of silently skipping it.
	if _, ok := buffer.Since(3); ok {
		t.Fatal("expected a detected gap to report ok=false")
	}
	if events, ok := buffer.Since(4); !ok || len(events) != 2 {
		t.Fatalf("expected a contiguous replay from seq 4, got ok=%v %+v", ok, events)
	}
}

func TestDeltaBufferPrunesExpiredEvents(t *testing.T) {
	buffer := NewDeltaBuffer(20*time.Millisecond, 1<<20)
	buffer.Add(deltaTestEvent(1, map[string]any{"value": "old"}))
	time.Sleep(40 * time.Millisecond)

	events, ok := buffer.Since(0)
	if !ok || len(events) != 0 {
		t.Fatalf("expected expired events to be pruned, got ok=%v %+v", ok, events)
	}
	if buffer.bytes != 0 {
		t.Fatalf("expected the byte budget to be released, got %d", buffer.bytes)
	}
	if len(buffer.events) != 0 {
		t.Fatalf("expected the retained slice to be empty, got %d", len(buffer.events))
	}
}

func TestDeltaBufferTrimsOldestEventsUnderBytePressure(t *testing.T) {
	buffer := NewDeltaBuffer(time.Minute, 200)
	for sequence := uint64(1); sequence <= 5; sequence++ {
		buffer.Add(deltaTestEvent(sequence, map[string]any{
			"value": "012345678901234567890123456789012345678901234567890123456789",
		}))
	}

	if buffer.bytes > buffer.maxBytes {
		t.Fatalf("expected the byte budget to be enforced, got %d > %d", buffer.bytes, buffer.maxBytes)
	}
	events, ok := buffer.Since(0)
	if !ok || len(events) == 0 {
		t.Fatalf("expected the newest events to be retained, got ok=%v %+v", ok, events)
	}
	if events[len(events)-1].RoomSeq != 5 {
		t.Fatalf("expected the newest event to survive trimming, got %+v", events)
	}
	for _, event := range events {
		if event.RoomSeq == 1 {
			t.Fatal("expected the oldest event to be trimmed first")
		}
	}
}

func TestDeltaBufferSnapshotsMutablePayloads(t *testing.T) {
	buffer := NewDeltaBuffer(time.Minute, 1<<20)
	points := []domain.Point{{X: 0.1, Y: 0.2, P: 0.5, Lamport: 1}}
	command := domain.NewCommand(map[string]any{
		"id": "cmd-1", "type": "path", "pageId": 0, "points": points,
	})
	payload := map[string]any{
		"points":  points,
		"command": command,
		"nested":  []any{map[string]any{"value": "before"}},
	}
	buffer.Add(deltaTestEvent(1, payload))

	// Mutating the caller's structures after Add must not rewrite replay data.
	points[0].X = 0.9
	command.SetPoints([]domain.Point{{X: 0.8, Y: 0.8, P: 0.5, Lamport: 9}})
	payload["nested"].([]any)[0].(map[string]any)["value"] = "after"

	events, ok := buffer.Since(0)
	if !ok || len(events) != 1 {
		t.Fatalf("expected one retained event, got ok=%v %+v", ok, events)
	}
	storedPoints, _ := events[0].Data["points"].([]domain.Point)
	if storedPoints[0].X != 0.1 {
		t.Fatalf("expected snapshotted points, got %+v", storedPoints)
	}
	storedCommand, _ := events[0].Data["command"].(domain.Command)
	if storedCommand.Points()[0].X != 0.1 {
		t.Fatalf("expected a snapshotted command, got %+v", storedCommand.Points())
	}
	nested, _ := events[0].Data["nested"].([]any)
	entry, _ := nested[0].(map[string]any)
	if entry["value"] != "before" {
		t.Fatalf("expected nested maps to be snapshotted, got %+v", entry)
	}
}

func v2SceneCommand(pointCount int) domain.Command {
	points := make([]any, pointCount)
	for index := range points {
		points[index] = map[string]any{
			"x": float64(index), "y": 1.0, "p": 0.5, "lamport": float64(index),
		}
	}
	return domain.NewCommand(map[string]any{
		"id": "scene-op-1", "type": "scene-op", "pageId": 0,
		"sceneOperation": map[string]any{
			"kind":    "element.append",
			"payload": map[string]any{"points": points},
		},
	})
}

func TestEstimateValueSizeTracksStructure(t *testing.T) {
	command := domain.NewCommand(map[string]any{
		"id": "cmd-1", "pageId": 0,
		"points": []domain.Point{{X: 0.1, Y: 0.1, P: 0.5, Lamport: 1}},
	})
	tests := []struct {
		name  string
		value any
		want  int
	}{
		{"nil", nil, 0},
		{"string", "abcd", 4},
		{"bool", true, 1},
		{"int", 42, 8},
		{"point slice", []domain.Point{{}, {}}, 2 * pointByteEstimate},
		{"flat point slice", []domain.FlatPoint{{}, {}, {}}, 3 * flatPointByteEstimate},
		// points moved out of the field map; "id" (2+5) and "pageId" (6+8) still count.
		{"command", command, pointByteEstimate + commandOverheadEstimate + 21},
		{"slice", []any{"ab", true}, 3},
		{"map", map[string]any{"key": "value"}, 8},
		{"unknown", struct{}{}, 16},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := estimateValueSize(test.value); got != test.want {
				t.Fatalf("expected %d, got %d", test.want, got)
			}
		})
	}

	// The event estimate always includes the type/binary/envelope overhead.
	if got := estimateDeltaSize(deltaTestEvent(1, nil)); got != len("cmd-start")+64 {
		t.Fatalf("unexpected empty-event estimate: %d", got)
	}
	if got := estimateDeltaSize(DeltaEvent{Type: "x", Binary: []byte{1, 2, 3}}); got != 1+3+64 {
		t.Fatalf("unexpected binary-event estimate: %d", got)
	}
}

func TestEstimateValueSizeCountsV2ScenePayloadPoints(t *testing.T) {
	command := v2SceneCommand(32)
	topLevelOnly := len(command.Points())*pointByteEstimate + commandOverheadEstimate
	got := estimateValueSize(command)
	if got <= topLevelOnly {
		t.Fatalf("V2 scene payload points are not counted: estimate=%d top-level-only=%d", got, topLevelOnly)
	}
	if extra := got - topLevelOnly; extra < 32*pointByteEstimate {
		t.Fatalf("nested V2 points under-counted: extra=%d want at least %d", extra, 32*pointByteEstimate)
	}
}

func TestDeltaBufferTrimsV2CommandsByFullPayloadSize(t *testing.T) {
	buffer := NewDeltaBuffer(time.Minute, 6000)
	for sequence := uint64(1); sequence <= 4; sequence++ {
		buffer.Add(deltaTestEvent(sequence, map[string]any{"cmd": v2SceneCommand(40)}))
	}
	if buffer.bytes > buffer.maxBytes {
		t.Fatalf("expected the byte budget to be enforced, got %d > %d", buffer.bytes, buffer.maxBytes)
	}
	if len(buffer.events) >= 4 {
		t.Fatalf("expected V2 payload bytes to trim old commands, retained %d", len(buffer.events))
	}
	if len(buffer.events) == 0 {
		t.Fatal("expected the newest V2 command to remain retained")
	}
}
