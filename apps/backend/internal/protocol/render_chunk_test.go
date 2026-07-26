package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"testing"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

func TestEncodeRenderChunkRoundTrip(t *testing.T) {
	points := []domain.FlatPoint{
		{CmdID: "a", UserID: "u1", Tool: "pen", Color: "#000", Size: 4, X: 0.5, Y: 0.25, P: 1, Lamport: 7},
		{CmdID: "b", UserID: "u2", Tool: "eraser", Color: "#fff", Size: 8, X: -1, Y: 2, P: 0.5, Lamport: 8},
		{CmdID: "a", UserID: "u1", Tool: "pen", Color: "#000", Size: 4, X: 1.5, Y: 3, P: 0.25, Lamport: 9},
	}
	commandMap, commands := BuildRenderDictionary(points)

	if len(commands) != 2 {
		t.Fatalf("expected 2 dictionary entries, got %d", len(commands))
	}
	if commandMap["a"] != 0 || commandMap["b"] != 1 {
		t.Fatalf("unexpected dictionary indexes: %v", commandMap)
	}

	frame, err := EncodeRenderChunk(points, commandMap, 11, 2)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(frame) != RenderHeaderSize+len(points)*int(RenderRecordSize) {
		t.Fatalf("unexpected frame length %d", len(frame))
	}
	if binary.BigEndian.Uint32(frame[:4]) != RenderMagic {
		t.Fatal("missing render magic")
	}
	if binary.BigEndian.Uint16(frame[4:]) != RenderVersion {
		t.Fatal("unexpected render version")
	}
	if binary.BigEndian.Uint16(frame[6:]) != RenderRecordSize {
		t.Fatal("unexpected record size")
	}
	if binary.BigEndian.Uint32(frame[8:]) != 11 {
		t.Fatal("unexpected snapshot version")
	}
	if binary.BigEndian.Uint32(frame[12:]) != 2 {
		t.Fatal("unexpected chunk index")
	}
	if binary.BigEndian.Uint32(frame[16:]) != uint32(len(points)) {
		t.Fatal("unexpected point count")
	}

	// Third record must point back at command "a".
	offset := RenderHeaderSize + 2*int(RenderRecordSize)
	if got := math.Float32frombits(binary.BigEndian.Uint32(frame[offset:])); got != 1.5 {
		t.Fatalf("record x mismatch: %v", got)
	}
	if got := binary.BigEndian.Uint16(frame[offset+20:]); got != 0 {
		t.Fatalf("expected command index 0 for cmd a, got %d", got)
	}
}

// TestEncodeRenderChunkRejectsDictionaryOverflow covers the bug this guard was
// added for: the command index is a uint16, and silently wrapping it rendered
// points with another command's tool, colour and size.
func TestEncodeRenderChunkRejectsDictionaryOverflow(t *testing.T) {
	commandMap := make(map[string]int, MaxRenderDictionaryEntries+1)
	for i := 0; i <= MaxRenderDictionaryEntries; i++ {
		commandMap[fmt.Sprintf("cmd-%d", i)] = i
	}
	points := []domain.FlatPoint{{CmdID: "cmd-0"}}

	if _, err := EncodeRenderChunk(points, commandMap, 1, 0); !errors.Is(err, ErrRenderDictionaryOverflow) {
		t.Fatalf("expected ErrRenderDictionaryOverflow, got %v", err)
	}
}

func TestEncodeRenderChunkRejectsUnknownCommand(t *testing.T) {
	points := []domain.FlatPoint{{CmdID: "missing"}}
	if _, err := EncodeRenderChunk(points, map[string]int{"other": 0}, 1, 0); err == nil {
		t.Fatal("expected an unknown command reference to be rejected")
	}
}

func TestEncodeRenderChunkAtDictionaryLimit(t *testing.T) {
	commandMap := make(map[string]int, MaxRenderDictionaryEntries)
	for i := 0; i < MaxRenderDictionaryEntries; i++ {
		commandMap[fmt.Sprintf("cmd-%d", i)] = i
	}
	points := []domain.FlatPoint{{CmdID: "cmd-65535"}}

	frame, err := EncodeRenderChunk(points, commandMap, 1, 0)
	if err != nil {
		t.Fatalf("encode at limit: %v", err)
	}
	if got := binary.BigEndian.Uint16(frame[RenderHeaderSize+20:]); got != 65535 {
		t.Fatalf("expected max index 65535, got %d", got)
	}
}
