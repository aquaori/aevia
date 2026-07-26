package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	"collaborative-whiteboard/apps/backend/internal/domain"
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

// MaxRenderDictionaryEntries is the number of distinct commands a single render
// chunk can reference, bounded by the uint16 command-index field in the binary
// record. Chunks are sized in points (config.MaxRenderChunkPoints), and a chunk
// cannot contain more distinct commands than points, so staying under that point
// bound keeps this satisfied.
const MaxRenderDictionaryEntries = 65536

// ErrRenderDictionaryOverflow signals that a chunk references more commands than
// the wire format can index. Encoding previously wrapped the index silently,
// which rendered points with another command's tool, colour and size.
var ErrRenderDictionaryOverflow = errors.New("render chunk references more than 65536 commands")

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

// EncodeRenderChunk serialises a render chunk. snapshotVersion is a stream
// correlation tag rather than a durable counter; it is transmitted as uint32 and
// only needs to be unique among concurrently in-flight streams for a room.
func EncodeRenderChunk(points []domain.FlatPoint, commandMap map[string]int, snapshotVersion, chunkIndex int) ([]byte, error) {
	if len(commandMap) > MaxRenderDictionaryEntries {
		return nil, fmt.Errorf("%w: %d entries", ErrRenderDictionaryOverflow, len(commandMap))
	}
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
		index, ok := commandMap[p.CmdID]
		if !ok {
			return nil, fmt.Errorf("render chunk point references unknown command %q", p.CmdID)
		}
		binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(float32(p.X)))
		offset += 4
		binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(float32(p.Y)))
		offset += 4
		binary.BigEndian.PutUint32(buf[offset:], math.Float32bits(float32(p.P)))
		offset += 4
		binary.BigEndian.PutUint64(buf[offset:], math.Float64bits(p.Lamport))
		offset += 8
		binary.BigEndian.PutUint16(buf[offset:], uint16(index))
		offset += 2
	}
	return buf, nil
}
