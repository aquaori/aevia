package protocol

import (
	"encoding/binary"
	"errors"
	"math"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

const (
	RealtimeMagic      uint32 = 0x43574252
	RealtimeVersion    byte   = 1
	RealtimeHeaderSize        = 6
	PointRecordSize           = 20
)

const (
	FrameMouseMoveClient byte = 1
	FrameMouseMoveServer byte = 2
	FrameCommandUpdate   byte = 3
)

type RealtimeMessage struct {
	Type   string
	Data   map[string]any
	Binary []byte
}

func HasRealtimeMagic(payload []byte) bool {
	return len(payload) >= RealtimeHeaderSize && binary.BigEndian.Uint32(payload[:4]) == RealtimeMagic
}

func DecodeRealtime(payload []byte) (RealtimeMessage, error) {
	if len(payload) < RealtimeHeaderSize || binary.BigEndian.Uint32(payload[:4]) != RealtimeMagic {
		return RealtimeMessage{}, errors.New("invalid realtime frame")
	}
	if payload[4] != RealtimeVersion {
		return RealtimeMessage{}, errors.New("unsupported realtime version")
	}
	switch payload[5] {
	case FrameMouseMoveClient:
		return decodeMouseMoveClient(payload)
	case FrameCommandUpdate:
		return decodeCommandUpdate(payload)
	default:
		return RealtimeMessage{}, errors.New("unsupported realtime frame")
	}
}

func EncodeMouseMoveServer(userID, userName string, pageID uint32, x, y float32) []byte {
	userIDBytes := []byte(userID)
	userNameBytes := []byte(userName)
	size := RealtimeHeaderSize + 1 + len(userIDBytes) + 1 + len(userNameBytes) + 12
	buf := make([]byte, size)
	writeRealtimeHeader(buf, FrameMouseMoveServer)
	offset := RealtimeHeaderSize
	buf[offset] = byte(len(userIDBytes))
	offset++
	copy(buf[offset:], userIDBytes)
	offset += len(userIDBytes)
	buf[offset] = byte(len(userNameBytes))
	offset++
	copy(buf[offset:], userNameBytes)
	offset += len(userNameBytes)
	binary.BigEndian.PutUint32(buf[offset:], pageID)
	offset += 4
	binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(x))
	offset += 4
	binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(y))
	return buf
}

func EncodeCommandUpdate(cmdID string, points []map[string]any) []byte {
	out := make([]domain.Point, 0, len(points))
	for _, point := range points {
		out = append(out, domain.Point{
			X:       number(point["x"]),
			Y:       number(point["y"]),
			P:       number(point["p"]),
			Lamport: number(point["lamport"]),
		})
	}
	return EncodeCommandUpdatePoints(cmdID, out)
}

func EncodeCommandUpdatePoints(cmdID string, points []domain.Point) []byte {
	cmdIDBytes := []byte(cmdID)
	buf := make([]byte, RealtimeHeaderSize+1+len(cmdIDBytes)+2+len(points)*PointRecordSize)
	writeRealtimeHeader(buf, FrameCommandUpdate)
	offset := RealtimeHeaderSize
	buf[offset] = byte(len(cmdIDBytes))
	offset++
	copy(buf[offset:], cmdIDBytes)
	offset += len(cmdIDBytes)
	binary.BigEndian.PutUint16(buf[offset:], uint16(len(points)))
	offset += 2
	for _, p := range points {
		binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(float32(p.X)))
		offset += 4
		binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(float32(p.Y)))
		offset += 4
		binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(float32(p.P)))
		offset += 4
		binary.BigEndian.PutUint64(buf[offset:], math.Float64bits(p.Lamport))
		offset += 8
	}
	return buf
}

func writeRealtimeHeader(buf []byte, frameType byte) {
	binary.BigEndian.PutUint32(buf[:4], RealtimeMagic)
	buf[4] = RealtimeVersion
	buf[5] = frameType
}

func decodeMouseMoveClient(payload []byte) (RealtimeMessage, error) {
	if len(payload) < RealtimeHeaderSize+12 {
		return RealtimeMessage{}, errors.New("truncated mouse frame")
	}
	offset := RealtimeHeaderSize
	pageID := binary.BigEndian.Uint32(payload[offset:])
	offset += 4
	x := math.Float32frombits(binary.BigEndian.Uint32(payload[offset:]))
	offset += 4
	y := math.Float32frombits(binary.BigEndian.Uint32(payload[offset:]))
	return RealtimeMessage{Type: "mouseMove", Data: map[string]any{
		"pageId": int(pageID), "x": float64(x), "y": float64(y), "__binary": true,
	}}, nil
}

func decodeCommandUpdate(payload []byte) (RealtimeMessage, error) {
	offset := RealtimeHeaderSize
	if len(payload) < offset+3 {
		return RealtimeMessage{}, errors.New("truncated command frame")
	}
	cmdLen := int(payload[offset])
	offset++
	if len(payload) < offset+cmdLen+2 {
		return RealtimeMessage{}, errors.New("truncated command id")
	}
	cmdID := string(payload[offset : offset+cmdLen])
	offset += cmdLen
	count := int(binary.BigEndian.Uint16(payload[offset:]))
	offset += 2
	if len(payload) != offset+count*PointRecordSize {
		return RealtimeMessage{}, errors.New("invalid point payload length")
	}
	points := make([]domain.Point, 0, count)
	for i := 0; i < count; i++ {
		x := math.Float32frombits(binary.BigEndian.Uint32(payload[offset:]))
		offset += 4
		y := math.Float32frombits(binary.BigEndian.Uint32(payload[offset:]))
		offset += 4
		p := math.Float32frombits(binary.BigEndian.Uint32(payload[offset:]))
		offset += 4
		lamport := math.Float64frombits(binary.BigEndian.Uint64(payload[offset:]))
		offset += 8
		points = append(points, domain.Point{X: float64(x), Y: float64(y), P: float64(p), Lamport: lamport})
	}
	return RealtimeMessage{
		Type:   "cmd-update",
		Data:   map[string]any{"cmdId": cmdID, "points": points, "__binary": true},
		Binary: append([]byte(nil), payload...),
	}, nil
}

func number(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int:
		return float64(x)
	}
	return 0
}
