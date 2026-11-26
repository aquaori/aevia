package room

import "collaborative-whiteboard/apps/backend/internal/domain"

type actorMessage interface{ isActorMessage() }

type joinMessage struct {
	Client      ClientInfo
	PageID      int
	LastRoomSeq uint64
	Reply       chan JoinResult
}

type leaveMessage struct {
	ClientID ClientID
}

type notifyUserMessage struct {
	UserID string
	Type   string
	Role   string
	Close  bool
}

type clientEventMessage struct {
	ClientID ClientID
	Type     string
	Data     map[string]any
	Binary   bool
	Frame    []byte
}

type pageChangeMessage struct {
	ClientID ClientID
	Request  PageChangeRequest
}

type snapshotRequest struct {
	PageID int
	Reply  chan InitStream
}

type pageReviewRequest struct {
	Reply chan PageReview
}

type causalDiagnosticsRequest struct {
	Reply chan CausalDiagnostics
}

type drainingMessage struct {
	Reason string
}

type shutdownMessage struct {
	Reason string
	Reply  chan struct{}
}

type JoinResult struct {
	err          error
	Room         domain.Room
	Init         InitStream
	InitStreamed bool
	Deltas       []DeltaEvent
	Resume       string
	ResumeSeq    uint64
	Online       int
	Members      [][2]string
}

type PageReview struct {
	RoomID    string           `json:"roomId"`
	TotalPage int              `json:"totalPage"`
	Pages     []PageReviewItem `json:"pages"`
}

type PageReviewItem struct {
	PageID            int `json:"pageId"`
	PageNumber        int `json:"pageNumber"`
	CollaboratorCount int `json:"collaboratorCount"`
}

func (joinMessage) isActorMessage()              {}
func (leaveMessage) isActorMessage()             {}
func (notifyUserMessage) isActorMessage()        {}
func (clientEventMessage) isActorMessage()       {}
func (pageChangeMessage) isActorMessage()        {}
func (snapshotRequest) isActorMessage()          {}
func (pageReviewRequest) isActorMessage()        {}
func (causalDiagnosticsRequest) isActorMessage() {}
func (drainingMessage) isActorMessage()          {}
func (shutdownMessage) isActorMessage()          {}
