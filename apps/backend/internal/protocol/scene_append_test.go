package protocol

import (
	"encoding/binary"
	"math"
	"testing"
)

func TestDecodeSceneAppend(t *testing.T) {
	metadata := []byte(`{"cmd":{"sceneOperation":{"kind":"element.append","payload":{"points":[]}}}}`)
	frame := make([]byte, 12+len(metadata)+32)
	binary.BigEndian.PutUint32(frame, SceneAppendMagic)
	binary.BigEndian.PutUint32(frame[4:], uint32(len(metadata)))
	binary.BigEndian.PutUint32(frame[8:], 1)
	copy(frame[12:], metadata)
	for i, value := range []float64{0.125, 0.25, 0.5, 42} {
		binary.BigEndian.PutUint64(frame[12+len(metadata)+i*8:], math.Float64bits(value))
	}
	data, err := DecodeSceneAppend(frame)
	if err != nil {
		t.Fatal(err)
	}
	point := data["cmd"].(map[string]any)["sceneOperation"].(map[string]any)["payload"].(map[string]any)["points"].([]any)[0].(map[string]any)
	if point["x"] != 0.125 || point["lamport"] != float64(42) {
		t.Fatalf("unexpected point: %v", point)
	}
	if _, err := DecodeSceneAppend(frame[:len(frame)-1]); err == nil {
		t.Fatal("accepted truncated frame")
	}
}
