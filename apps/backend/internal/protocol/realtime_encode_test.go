package protocol

import (
	"encoding/binary"
	"math"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func TestEncodeMouseMoveServerAndCommandUpdate(t *testing.T) {
	frame := EncodeMouseMoveServer("user-1", "Alice", 3, 0.25, 0.75)
	if !HasRealtimeMagic(frame) {
		t.Fatal("expected server mouse move frame to carry realtime magic")
	}
	if frame[5] != FrameMouseMoveServer {
		t.Fatalf("expected FrameMouseMoveServer, got %d", frame[5])
	}
	offset := RealtimeHeaderSize
	uidLen := int(frame[offset])
	offset++
	if string(frame[offset:offset+uidLen]) != "user-1" {
		t.Fatalf("unexpected user id in encoded frame")
	}
	offset += uidLen
	nameLen := int(frame[offset])
	offset++
	if string(frame[offset:offset+nameLen]) != "Alice" {
		t.Fatalf("unexpected user name in encoded frame")
	}
	offset += nameLen
	if gotPage := binary.BigEndian.Uint32(frame[offset : offset+4]); gotPage != 3 {
		t.Fatalf("expected page 3, got %d", gotPage)
	}
	gotX := math.Float32frombits(binary.BigEndian.Uint32(frame[offset+4 : offset+8]))
	gotY := math.Float32frombits(binary.BigEndian.Uint32(frame[offset+8 : offset+12]))
	if gotX != 0.25 || gotY != 0.75 {
		t.Fatalf("expected (0.25, 0.75), got (%v, %v)", gotX, gotY)
	}

	cmdFrame := EncodeCommandUpdate("cmd-9", []map[string]any{
		{"x": 0.1, "y": 0.2, "p": 0.5, "lamport": 4.0},
	})
	decoded, err := DecodeRealtime(cmdFrame)
	if err != nil {
		t.Fatalf("decode command update: %v", err)
	}
	pts, _ := decoded.Data["points"].([]domain.Point)
	if decoded.Type != "cmd-update" || decoded.Data["cmdId"] != "cmd-9" || len(pts) != 1 {
		t.Fatalf("unexpected decoded command update: %+v", decoded)
	}
}

func TestDecodeRealtimeRejectsMalformedFrames(t *testing.T) {
	if HasRealtimeMagic([]byte{1, 2}) {
		t.Fatal("expected short slice to return false")
	}
	if _, err := DecodeRealtime([]byte{0, 0, 0, 0, 1, 1}); err == nil {
		t.Fatal("expected invalid magic error")
	}
	badVer := make([]byte, RealtimeHeaderSize)
	binary.BigEndian.PutUint32(badVer[:4], RealtimeMagic)
	badVer[4] = 99
	if _, err := DecodeRealtime(badVer); err == nil {
		t.Fatal("expected unsupported version error")
	}
	badType := make([]byte, RealtimeHeaderSize)
	binary.BigEndian.PutUint32(badType[:4], RealtimeMagic)
	badType[4] = RealtimeVersion
	badType[5] = 99
	if _, err := DecodeRealtime(badType); err == nil {
		t.Fatal("expected unsupported frame type error")
	}
}
