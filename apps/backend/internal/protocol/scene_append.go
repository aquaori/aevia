package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
)

const SceneAppendMagic uint32 = 0x41563250

// DecodeSceneAppend restores the normal push-cmd payload before gateway validation.
func DecodeSceneAppend(frame []byte) (map[string]any, error) {
	if len(frame) < 12 || binary.BigEndian.Uint32(frame[:4]) != SceneAppendMagic {
		return nil, errors.New("invalid scene append header")
	}
	metadataLength := uint64(binary.BigEndian.Uint32(frame[4:8]))
	count := uint64(binary.BigEndian.Uint32(frame[8:12]))
	if metadataLength > uint64(len(frame)-12) || count > uint64(len(frame))/32 || 12+metadataLength+count*32 != uint64(len(frame)) {
		return nil, errors.New("invalid scene append length")
	}
	var data map[string]any
	if err := json.Unmarshal(frame[12:12+metadataLength], &data); err != nil {
		return nil, err
	}
	cmd, ok := data["cmd"].(map[string]any)
	if !ok {
		return nil, errors.New("missing command")
	}
	op, ok := cmd["sceneOperation"].(map[string]any)
	if !ok || op["kind"] != "element.append" {
		return nil, errors.New("invalid operation")
	}
	payload, ok := op["payload"].(map[string]any)
	if !ok {
		return nil, errors.New("missing payload")
	}
	points := make([]any, 0, count)
	offset := int(12 + metadataLength)
	for i := uint64(0); i < count; i++ {
		values := [4]float64{}
		for j := range values {
			values[j] = math.Float64frombits(binary.BigEndian.Uint64(frame[offset : offset+8]))
			offset += 8
		}
		points = append(points, map[string]any{"x": values[0], "y": values[1], "p": values[2], "lamport": values[3]})
	}
	payload["points"] = points
	return data, nil
}
