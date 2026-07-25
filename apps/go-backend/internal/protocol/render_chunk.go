package protocol

import (
	"encoding/binary"
	"math"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

const (
	RenderMagic      uint32 = 0x49524348
	RenderVersion    uint16 = 1
	RenderHeaderSize        = 20
	RenderRecordSize uint16 = 22
)

type RenderCommandRef struct {
	CmdIndex  int     `json:"cmdIndex"`
	CmdID     string  `json:"cmdId"`
	UserID    string  `json:"userId"`
	Tool      string  `json:"tool"`
	Color     string  `json:"color"`
	Size      float64 `json:"size"`
	IsDeleted bool    `json:"isDeleted"`
}

func BuildRenderDictionary(points []domain.FlatPoint) (map[string]int, []RenderCommandRef) {
	commandMap := make(map[string]int)
	commands := make([]RenderCommandRef, 0)
	for _, p := range points {
		if _, exists := commandMap[p.CmdID]; exists {
			continue
		}
		index := len(commands)
		commandMap[p.CmdID] = index
		commands = append(commands, RenderCommandRef{
			CmdIndex: index, CmdID: p.CmdID, UserID: p.UserID,
			Tool: p.Tool, Color: p.Color, Size: p.Size, IsDeleted: p.IsDeleted,
		})
	}
	return commandMap, commands
}

func EncodeRenderChunk(points []domain.FlatPoint, commandMap map[string]int, snapshotVersion, chunkIndex int) []byte {
	buf := make([]byte, RenderHeaderSize+len(points)*int(RenderRecordSize))
	offset := 0
	binary.BigEndian.PutUint32(buf[offset:], RenderMagic)
	offset += 4
	binary.BigEndian.PutUint16(buf[offset:], RenderVersion)
	offset += 2
	binary.BigEndian.PutUint16(buf[offset:], RenderRecordSize)
	offset += 2
	binary.BigEndian.PutUint32(buf[offset:], uint32(snapshotVersion))
	offset += 4
	binary.BigEndian.PutUint32(buf[offset:], uint32(chunkIndex))
	offset += 4
	binary.BigEndian.PutUint32(buf[offset:], uint32(len(points)))
	offset += 4

	for _, p := range points {
		binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(float32(p.X)))
		offset += 4
		binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(float32(p.Y)))
		offset += 4
		binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(float32(p.P)))
		offset += 4
		binary.BigEndian.PutUint64(buf[offset:], math.Float64bits(p.Lamport))
		offset += 8
		binary.BigEndian.PutUint16(buf[offset:], uint16(commandMap[p.CmdID]))
		offset += 2
	}
	return buf
}
