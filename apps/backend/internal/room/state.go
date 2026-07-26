package room

import (
	"time"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

type State struct {
	Room     domain.Room
	Commands map[string]domain.Command
	Index    *PagePointIndex
	Clients  map[ClientID]ClientInfo
	RoomSeq  uint64
	ReadOnly bool
	Deltas   *DeltaBuffer
}

func NewState(room domain.Room, commands []domain.Command) State {
	commandMap := make(map[string]domain.Command, len(commands))
	for _, cmd := range commands {
		commandMap[cmd.ID()] = cmd
	}
	return State{
		Room:     room,
		Commands: commandMap,
		Index:    NewPagePointIndex(commands),
		Clients:  make(map[ClientID]ClientInfo),
		RoomSeq:  room.DurableSeq,
		Deltas:   NewDeltaBuffer(30*time.Second, 64*1024*1024),
	}
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
}

func (s *State) DeleteCommand(cmdID string) bool {
	if _, ok := s.Commands[cmdID]; !ok {
		return false
	}
	delete(s.Commands, cmdID)
	s.Index.Remove(cmdID)
	return true
}

func (s *State) Clear(pageID *int) {
	if pageID == nil {
		s.Commands = make(map[string]domain.Command)
		s.Index.ClearAll()
		return
	}
	for cmdID, cmd := range s.Commands {
		if cmdPageID, ok := cmd.PageID(); ok && cmdPageID == *pageID {
			delete(s.Commands, cmdID)
		}
	}
	s.Index.ClearPage(*pageID)
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
