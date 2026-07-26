package room

import (
	"log/slog"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

func (a *Actor) handleBatchMove(client ClientInfo, msg clientEventMessage) {
	cmdIDs := stringSlice(msg.Data["cmdIds"])
	dx := domain.FloatDefault(msg.Data["dx"], 0)
	dy := domain.FloatDefault(msg.Data["dy"], 0)
	for _, cmdID := range cmdIDs {
		existing, ok := a.state.Commands[cmdID]
		if !ok {
			a.reject(client, "cmd-batch-move", "COMMAND_NOT_FOUND", "At least one target command does not exist.", cmdID)
			return
		}
		cmd := existing.Clone()
		points := cmd.Points()
		for i := range points {
			points[i].X += dx
			points[i].Y += dy
		}
		cmd.SetPoints(points)
		if !a.persistCommand(client, "cmd-batch-move", cmd, mutationOptions{Barrier: false, UserID: client.UserID}) {
			return
		}
	}
	slog.Debug("room command", "room", a.roomID, "type", "cmd-batch-move", "count", len(cmdIDs), "user", client.UserID)
	a.metrics.Commands.Add(1)
	msg.Data["roomSeq"] = a.state.RoomSeq
	data := withTrustedIdentity(client, msg.Data)
	a.recordAndBroadcast(client.ID, "cmd-batch-move", data, Envelope{Type: "cmd-batch-move", Data: data}, nil)
	a.ack(client, "committed", data)
}

func (a *Actor) handleBatchUpdate(client ClientInfo, msg clientEventMessage) {
	updates := mapSlice(msg.Data["updates"])
	for _, update := range updates {
		cmdID := domain.String(update["cmdId"])
		existing, ok := a.state.Commands[cmdID]
		if !ok {
			a.reject(client, msg.Type, "COMMAND_NOT_FOUND", "At least one target command does not exist.", cmdID)
			return
		}
		cmd := existing.Clone()
		cmd.SetPoints(pointsFromAny(update["points"]))
		if msg.Type == "cmd-batch-stop" && update["boxes"] != nil {
			cmd.Set("box", update["boxes"])
		}
		if !a.persistCommand(client, msg.Type, cmd, mutationOptions{Barrier: msg.Type == "cmd-batch-stop", UserID: client.UserID}) {
			return
		}
	}
	slog.Debug("room command", "room", a.roomID, "type", msg.Type, "count", len(updates), "user", client.UserID)
	a.metrics.Commands.Add(1)
	msg.Data["roomSeq"] = a.state.RoomSeq
	data := withTrustedIdentity(client, msg.Data)
	a.recordAndBroadcast(client.ID, msg.Type, data, Envelope{Type: msg.Type, Data: data}, nil)
	a.ack(client, "committed", data)
}
