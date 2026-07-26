package room

import (
	"log/slog"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

// mutationOptions controls how a room mutation is persisted. Barrier writes block
// the actor until the transaction commits; non-barrier writes are batched and
// report failures asynchronously through Actor.NotifyWriteFailure.
type mutationOptions struct {
	Barrier bool
	UserID  string
}

func (a *Actor) ensureWritable(client ClientInfo, opType string) bool {
	if a.state.ReadOnly || a.store.IsDegraded() {
		a.state.ReadOnly = true
		a.reject(client, opType, "DEGRADED_READ_ONLY", "Database is unavailable; room is read-only.", "")
		return false
	}
	return true
}

func (a *Actor) persistCommand(client ClientInfo, opType string, cmd domain.Command, options mutationOptions) bool {
	if !a.ensureWritable(client, opType) {
		return false
	}
	roomSeq := a.state.NextRoomSeq()
	cmd.Set("roomSeq", roomSeq)
	a.state.UpsertCommand(cmd)

	err := a.store.SaveCommandAtSeq(a.roomID, cmd, roomSeq, options.Barrier)
	if err != nil {
		a.enterReadOnly("persist command failed", err)
		a.reject(client, opType, "DB_WRITE_FAILED", "Server failed to persist the command.", cmd.ID())
		return false
	}
	return true
}

func (a *Actor) persistDelete(client ClientInfo, opType, cmdID string, options mutationOptions) bool {
	if !a.ensureWritable(client, opType) {
		return false
	}
	if _, ok := a.state.Commands[cmdID]; !ok {
		a.reject(client, opType, "COMMAND_NOT_FOUND", "Target command does not exist.", cmdID)
		return false
	}
	roomSeq := a.state.NextRoomSeq()
	a.state.DeleteCommand(cmdID)
	err := a.store.DeleteCommandAtSeq(a.roomID, cmdID, roomSeq, options.Barrier)
	if err != nil {
		a.enterReadOnly("persist delete failed", err)
		a.reject(client, opType, "DB_WRITE_FAILED", "Server failed to delete the command.", cmdID)
		return false
	}
	return true
}

func (a *Actor) persistClear(client ClientInfo, pageID *int, options mutationOptions) (uint64, bool) {
	if !a.ensureWritable(client, "push-cmd") {
		return 0, false
	}
	roomSeq := a.state.NextRoomSeq()
	a.state.Clear(pageID)
	err := a.store.ClearCommandsAtSeq(a.roomID, pageID, roomSeq, options.Barrier)
	if err != nil {
		a.enterReadOnly("persist clear failed", err)
		a.reject(client, "push-cmd", "DB_WRITE_FAILED", "Server failed to clear commands.", "")
		return 0, false
	}
	return roomSeq, true
}

func (a *Actor) persistPageAdd(client ClientInfo, options mutationOptions) (uint64, bool) {
	if !a.ensureWritable(client, "cmd-page-add") {
		return 0, false
	}
	roomSeq := a.state.NextRoomSeq()
	a.state.Room.TotalPage++
	err := a.store.IncrementPageAtSeq(a.roomID, roomSeq, options.Barrier)
	if err != nil {
		a.enterReadOnly("persist page add failed", err)
		a.reject(client, "cmd-page-add", "DB_WRITE_FAILED", "Server failed to add page.", "")
		return 0, false
	}
	return roomSeq, true
}

func (a *Actor) enterReadOnly(message string, err error) {
	a.state.ReadOnly = true
	a.metrics.DBFailures.Add(1)
	slog.Error(message, "room", a.roomID, "error", err)
	a.broadcastAll(Envelope{Type: "resync.required", Data: map[string]any{
		"reason":  "degraded-read-only",
		"roomSeq": a.state.RoomSeq,
	}}, nil)
}
