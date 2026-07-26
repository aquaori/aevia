package room

import "collaborative-whiteboard/apps/go-backend/internal/domain"

type ClientID string

type ClientInfo struct {
	ID       ClientID
	UserID   string
	UserName string
	PageID   int
	Epoch    uint64
	Send     chan Outbound
}

type Outbound struct {
	JSON   any
	Text   []byte
	Binary []byte
	Close  bool
	Bytes  int
	Frozen bool
}

type Envelope struct {
	Type     string         `json:"type"`
	PushType string         `json:"pushType,omitempty"`
	Data     map[string]any `json:"data"`
}

type InitStream struct {
	SnapshotVersion int
	Meta            map[string]any
	RenderChunks    []RenderChunk
	CommandChunks   []CommandChunk
}

type RenderChunk struct {
	ChunkIndex   int
	IsLast       bool
	Points       []domain.FlatPoint
	LamportStart any
	LamportEnd   any
}

type CommandChunk struct {
	ChunkIndex int
	IsLast     bool
	Commands   []domain.Command
}

type PageChangeRequest struct {
	RequestID           int
	PrevPageID          *int
	NextPageID          *int
	PageID              *int
	ClientLoadedPageIDs []int
}

type DeltaEvent struct {
	RoomSeq uint64
	Type    string
	Data    map[string]any
	Binary  []byte
}
