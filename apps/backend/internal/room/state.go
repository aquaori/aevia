package room

import (
	"time"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

type State struct {
	Room        domain.Room
	Commands    map[string]domain.Command
	Index       *PagePointIndex
	Clients     map[ClientID]ClientInfo
	RoomSeq     uint64
	ReadOnly    bool
	Deltas      *DeltaBuffer
	ClearBefore map[int]sceneOrderKey
}

type sceneOrderKey struct {
	Lamport     float64
	OpID        string
	SourceIndex int
	SubIndex    int
}

func compareSceneOrder(left, right sceneOrderKey) int {
	if left.Lamport < right.Lamport {
		return -1
	}
	if left.Lamport > right.Lamport {
		return 1
	}
	if left.OpID < right.OpID {
		return -1
	}
	if left.OpID > right.OpID {
		return 1
	}
	if left.SourceIndex < right.SourceIndex {
		return -1
	}
	if left.SourceIndex > right.SourceIndex {
		return 1
	}
	if left.SubIndex < right.SubIndex {
		return -1
	}
	if left.SubIndex > right.SubIndex {
		return 1
	}
	return 0
}

func NewState(room domain.Room, commands []domain.Command) State {
	commandMap := make(map[string]domain.Command, len(commands))
	for _, cmd := range commands {
		commandMap[cmd.ID()] = cmd
	}
	state := State{
		Room:        room,
		Commands:    commandMap,
		Index:       NewPagePointIndex(commands),
		Clients:     make(map[ClientID]ClientInfo),
		RoomSeq:     room.DurableSeq,
		Deltas:      NewDeltaBuffer(30*time.Second, 64*1024*1024),
		ClearBefore: make(map[int]sceneOrderKey),
	}
	state.rebuildClearWatermarks()
	return state
}

func (s *State) NextRoomSeq() uint64 {
	s.RoomSeq++
	return s.RoomSeq
}

// The in-memory mutators below deliberately take no roomSeq: the sequence is
// allocated by the caller (see Actor.persist*) and recorded on the command and in
// storage. These previously accepted a roomSeq argument and discarded it, which
// implied a sequencing guarantee this layer never provided.

func (s *State) UpsertCommand(cmd domain.Command) {
	stored := cmd.Snapshot()
	s.Commands[stored.ID()] = stored
	s.Index.Upsert(stored)
	if s.affectsClearWatermark(stored) {
		s.rebuildClearWatermarks()
	}
}

func sceneOperation(cmd domain.Command) map[string]any {
	operation, _ := cmd.Get("sceneOperation").(map[string]any)
	return operation
}

func sceneOperationKind(cmd domain.Command) string {
	return domain.String(sceneOperation(cmd)["kind"])
}

func (s *State) rebuildClearWatermarks() {
	commands := make([]domain.Command, 0, len(s.Commands))
	for _, cmd := range s.Commands {
		commands = append(commands, cmd)
	}
	domain.SortCommands(commands)
	historyEnabled := make(map[string]bool)
	for _, cmd := range commands {
		operation := sceneOperation(cmd)
		if domain.String(operation["kind"]) != "history.toggle" {
			continue
		}
		payload, _ := operation["payload"].(map[string]any)
		target := domain.String(payload["targetHistoryGroupId"])
		if target != "" {
			historyEnabled[target] = domain.Bool(payload["enabled"])
		}
	}
	next := make(map[int]sceneOrderKey)
	for _, cmd := range commands {
		operation := sceneOperation(cmd)
		if domain.String(operation["kind"]) != "page.clear" {
			continue
		}
		groupID := domain.String(operation["historyGroupId"])
		if enabled, exists := historyEnabled[groupID]; exists && !enabled {
			continue
		}
		pageID := domain.IntDefault(operation["pageId"], -1)
		payload, _ := operation["payload"].(map[string]any)
		before, _ := payload["before"].(map[string]any)
		watermark := sceneOrderKey{
			Lamport:     domain.FloatDefault(before["lamport"], 0),
			OpID:        domain.String(before["opId"]),
			SourceIndex: domain.IntDefault(before["sourceIndex"], 0),
			SubIndex:    domain.IntDefault(before["subIndex"], 0),
		}
		if pageID < 0 || watermark.OpID == "" {
			continue
		}
		if current, exists := next[pageID]; !exists || compareSceneOrder(current, watermark) < 0 {
			next[pageID] = watermark
		}
	}
	s.ClearBefore = next
}

func (s *State) DeleteCommand(cmdID string) bool {
	command, ok := s.Commands[cmdID]
	if !ok {
		return false
	}
	delete(s.Commands, cmdID)
	s.Index.Remove(cmdID)
	if s.affectsClearWatermark(command) {
		s.rebuildClearWatermarks()
	}
	return true
}

func (s *State) affectsClearWatermark(cmd domain.Command) bool {
	kind := sceneOperationKind(cmd)
	if kind == "page.clear" {
		return true
	}
	if kind != "history.toggle" {
		return false
	}
	operation := sceneOperation(cmd)
	payload, _ := operation["payload"].(map[string]any)
	target := domain.String(payload["targetHistoryGroupId"])
	if target == "" {
		return false
	}
	for _, existing := range s.Commands {
		if sceneOperationKind(existing) != "page.clear" {
			continue
		}
		if domain.String(sceneOperation(existing)["historyGroupId"]) == target {
			return true
		}
	}
	return false
}

func (s *State) Clear(pageID *int) {
	if pageID == nil {
		s.Commands = make(map[string]domain.Command)
		s.Index.ClearAll()
		s.ClearBefore = make(map[int]sceneOrderKey)
		return
	}
	for cmdID, cmd := range s.Commands {
		if cmdPageID, ok := cmd.PageID(); ok && cmdPageID == *pageID {
			delete(s.Commands, cmdID)
		}
	}
	s.Index.ClearPage(*pageID)
	delete(s.ClearBefore, *pageID)
}

func (s *State) OnlineMembers() [][2]string {
	seen := map[string]bool{}
	members := make([][2]string, 0, len(s.Clients))
	for _, client := range s.Clients {
		if seen[client.UserID] {
			continue
		}
		seen[client.UserID] = true
		members = append(members, [2]string{client.UserID, client.UserName})
	}
	return members
}

func (s *State) PageReview() PageReview {
	counts := make(map[int]int)
	for _, client := range s.Clients {
		pageID := normalizePageID(client.PageID, s.Room.TotalPage)
		counts[pageID]++
	}
	pages := make([]PageReviewItem, 0, s.Room.TotalPage)
	for pageID := 0; pageID < s.Room.TotalPage; pageID++ {
		pages = append(pages, PageReviewItem{
			PageID: pageID, PageNumber: pageID + 1, CollaboratorCount: counts[pageID],
		})
	}
	return PageReview{RoomID: s.Room.RoomID, TotalPage: s.Room.TotalPage, Pages: pages}
}
