package protocol

import (
	"encoding/binary"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func TestDecodeCommandUpdateRoundTrip(t *testing.T) {
	points := []domain.Point{
		{X: 0.25, Y: 0.5, P: 0.75, Lamport: 12},
		{X: -1.5, Y: 2.25, P: 1, Lamport: 13},
	}
	frame := EncodeCommandUpdatePoints("cmd-1", points)

	msg, err := DecodeRealtime(frame)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if msg.Type != "cmd-update" {
		t.Fatalf("expected cmd-update, got %q", msg.Type)
	}
	if msg.Data["cmdId"] != "cmd-1" {
		t.Fatalf("cmdId mismatch: %v", msg.Data["cmdId"])
	}
	decoded, ok := msg.Data["points"].([]domain.Point)
	if !ok {
		t.Fatalf("expected []domain.Point, got %T", msg.Data["points"])
	}
	if len(decoded) != len(points) {
		t.Fatalf("expected %d points, got %d", len(points), len(decoded))
	}
	for i, want := range points {
		got := decoded[i]
		// X/Y/P travel as float32, so compare with that precision.
		if float32(got.X) != float32(want.X) || float32(got.Y) != float32(want.Y) || float32(got.P) != float32(want.P) {
			t.Fatalf("point %d coordinate mismatch: got %+v want %+v", i, got, want)
		}
		if got.Lamport != want.Lamport {
			t.Fatalf("point %d lamport mismatch: got %v want %v", i, got.Lamport, want.Lamport)
		}
	}
}

func TestDecodeMouseMoveRoundTrip(t *testing.T) {
	frame := make([]byte, RealtimeHeaderSize+12)
	binary.BigEndian.PutUint32(frame[:4], RealtimeMagic)
	frame[4] = RealtimeVersion
	frame[5] = FrameMouseMoveClient
	binary.BigEndian.PutUint32(frame[RealtimeHeaderSize:], 3)
	binary.BigEndian.PutUint32(frame[RealtimeHeaderSize+4:], 0x3F000000) // 0.5
	binary.BigEndian.PutUint32(frame[RealtimeHeaderSize+8:], 0x3E800000) // 0.25

	msg, err := DecodeRealtime(frame)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if msg.Type != "mouseMove" {
		t.Fatalf("expected mouseMove, got %q", msg.Type)
	}
	if msg.Data["pageId"] != 3 {
		t.Fatalf("pageId mismatch: %v", msg.Data["pageId"])
	}
	if msg.Data["x"] != 0.5 || msg.Data["y"] != 0.25 {
		t.Fatalf("coordinate mismatch: x=%v y=%v", msg.Data["x"], msg.Data["y"])
	}
}

func TestDecodeRealtimeRejectsBadFrames(t *testing.T) {
	valid := EncodeCommandUpdatePoints("cmd-1", []domain.Point{{X: 1, Y: 2, P: 1, Lamport: 1}})

	badMagic := append([]byte(nil), valid...)
	binary.BigEndian.PutUint32(badMagic[:4], 0xDEADBEEF)

	badVersion := append([]byte(nil), valid...)
	badVersion[4] = RealtimeVersion + 9

	badType := append([]byte(nil), valid...)
	badType[5] = 0x7F

	cases := map[string][]byte{
		"empty":            {},
		"short header":     valid[:3],
		"bad magic":        badMagic,
		"bad version":      badVersion,
		"unknown frame":    badType,
		"truncated points": valid[:len(valid)-4],
	}
	for name, frame := range cases {
		if _, err := DecodeRealtime(frame); err == nil {
			t.Fatalf("expected %s frame to be rejected", name)
		}
	}
}

// TestDecodeCommandUpdateRejectsLengthMismatch guards the declared-count versus
// actual-payload check, which is what keeps a crafted frame from over-reading.
func TestDecodeCommandUpdateRejectsLengthMismatch(t *testing.T) {
	frame := EncodeCommandUpdatePoints("cmd-1", []domain.Point{{X: 1, Y: 1, P: 1, Lamport: 1}})
	offset := RealtimeHeaderSize + 1 + len("cmd-1")
	binary.BigEndian.PutUint16(frame[offset:], 500) // claim far more points than present

	if _, err := DecodeRealtime(frame); err == nil {
		t.Fatal("expected a point-count/payload-length mismatch to be rejected")
	}
}

func TestHasRealtimeMagic(t *testing.T) {
	frame := EncodeCommandUpdatePoints("c", nil)
	if !HasRealtimeMagic(frame) {
		t.Fatal("expected encoded frame to carry the realtime magic")
	}
	if HasRealtimeMagic([]byte{1, 2, 3}) {
		t.Fatal("expected a short buffer to not match")
	}
}
