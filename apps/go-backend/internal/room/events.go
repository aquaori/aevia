package room

import (
	"log/slog"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

func (a *Actor) handleClientEvent(msg clientEventMessage) {
	client, ok := a.state.Clients[msg.ClientID]
	if !ok {
		return
	}
	if a.draining && !isRealtime(msg.Type) && msg.Type != "get-member-list" {
		a.reject(client, msg.Type, "SERVER_DRAINING", "Server is draining and no longer accepts board changes.", "")
		return
	}
	switch msg.Type {
	case "push-cmd", "cmd-start":
		a.handleCommandCreate(client, msg)
	case "cmd-update":
		a.handleCommandUpdate(client, msg)
	case "cmd-stop":
		a.handleCommandStop(client, msg)
	case "undo-cmd", "redo-cmd":
		a.handleUndoRedo(client, msg)
	case "delete-cmd":
		a.handleDelete(client, msg)
	case "cmd-batch-move":
		a.handleBatchMove(client, msg)
	case "cmd-batch-update", "cmd-batch-stop":
		a.handleBatchUpdate(client, msg)
	case "cmd-page-add":
		a.handlePageAdd(client, msg)
	case "mouseMove", "mouseLeave", "box-selection":
		a.broadcastExcept(msg.ClientID, Envelope{Type: msg.Type, Data: withTrustedIdentity(client, msg.Data)}, nil)
	case "get-member-list":
		sendOutbound(client.Send, Outbound{JSON: Envelope{Type: "get-member-list", Data: map[string]any{"memberList": a.state.OnlineMembers()}}})
	}
}

func (a *Actor) handleCommandCreate(client ClientInfo, msg clientEventMessage) {
	cmd := commandFromData(msg.Data["cmd"])
	if cmd == nil {
		a.reject(client, msg.Type, "INVALID_COMMAND_FORMAT", "Command payload is malformed.", "")
		return
	}
	cmd.SetIdentity(client.UserID, a.roomID)
	if cmd.ID() == "" {
		a.reject(client, msg.Type, "INVALID_COMMAND_FORMAT", "Command payload is malformed.", "")
		return
	}
	if cmd.Type() == "clear" {
		pageID, _ := cmd.PageID()
		roomSeq, ok := a.persistClear(client, &pageID, mutationOptions{Barrier: true, UserID: client.UserID})
		if !ok {
			return
		}
		cmd.Set("roomSeq", roomSeq)
		slog.Debug("room command", "room", a.roomID, "type", "clear", "page", pageID, "user", client.UserID)
	} else {
		barrier := cmd.Type() != "path" || msg.Type == "push-cmd"
		if !a.persistCommand(client, msg.Type, cmd, mutationOptions{Barrier: barrier, UserID: client.UserID}) {
			return
		}
		slog.Debug("room command", "room", a.roomID, "type", msg.Type, "cmd", cmd.ID(), "user", client.UserID)
	}
	a.metrics.Commands.Add(1)
	pushType := "normal"
	if msg.Type == "cmd-start" {
		pushType = "start"
	}
	data := map[string]any{"cmd": cmd, "roomSeq": cmd.Get("roomSeq")}
	a.recordAndBroadcast(client.ID, "push-cmd", data, Envelope{Type: "push-cmd", PushType: pushType, Data: data}, nil)
	a.ack(client, "accepted", data)
}

func (a *Actor) handleCommandUpdate(client ClientInfo, msg clientEventMessage) {
	cmdID := domain.String(msg.Data["cmdId"])
	existing, ok := a.state.Commands[cmdID]
	if !ok {
		a.reject(client, "cmd-update", "COMMAND_NOT_FOUND", "Target command does not exist.", cmdID)
		return
	}
	points := pointsFromAny(msg.Data["points"])
	if !a.validateAppend(client, "cmd-update", cmdID, existing, points, msg.Data) {
		return
	}
	cmd := existing.Clone()
	cmd.SetPoints(append(cmd.Points(), points...))
	if !a.persistCommand(client, "cmd-update", cmd, mutationOptions{Barrier: false, UserID: client.UserID}) {
		return
	}
	// The binary frame is the dominant cmd-update transport, so it must be counted
	// too; leaving it out made the Commands metric report a small fraction of real
	// traffic.
	a.metrics.Commands.Add(1)
	if msg.Binary {
		frame := msg.Frame
		if frame == nil {
			frame = encodeCommandUpdate(cmdID, msg.Data["points"])
		}
		a.recordAndBroadcast(client.ID, "push-cmd", map[string]any{"cmdId": cmdID, "points": msg.Data["points"], "roomSeq": cmd.Get("roomSeq")}, nil, frame)
		return
	}
	data := map[string]any{"cmdId": cmdID, "points": msg.Data["points"], "roomSeq": cmd.Get("roomSeq")}
	a.recordAndBroadcast(client.ID, "push-cmd", data, Envelope{Type: "push-cmd", PushType: "update", Data: data}, nil)
	a.ack(client, "accepted", data)
}

func (a *Actor) handleCommandStop(client ClientInfo, msg clientEventMessage) {
	cmdID := domain.String(msg.Data["cmdId"])
	existing, ok := a.state.Commands[cmdID]
	if !ok {
		a.reject(client, "cmd-stop", "COMMAND_NOT_FOUND", "Target command does not exist.", cmdID)
		return
	}
	points := pointsFromAny(msg.Data["points"])
	if !a.validateAppend(client, "cmd-stop", cmdID, existing, points, msg.Data) {
		return
	}
	cmd := existing.Clone()
	cmd.SetPoints(append(cmd.Points(), points...))
	if nested := commandFromData(msg.Data["cmd"]); nested != nil && nested.Get("box") != nil {
		cmd.Set("box", nested.Get("box"))
	}
	if !a.persistCommand(client, "cmd-stop", cmd, mutationOptions{Barrier: true, UserID: client.UserID}) {
		return
	}
	slog.Debug("room command", "room", a.roomID, "type", "cmd-stop", "cmd", cmdID, "user", client.UserID)
	a.metrics.Commands.Add(1)
	msg.Data["roomSeq"] = cmd.Get("roomSeq")
	a.recordAndBroadcast(client.ID, "push-cmd", msg.Data, Envelope{Type: "push-cmd", PushType: "stop", Data: msg.Data}, nil)
	a.ack(client, "committed", msg.Data)
}

func (a *Actor) handleUndoRedo(client ClientInfo, msg clientEventMessage) {
	cmdID := domain.String(msg.Data["cmdId"])
	existing, ok := a.state.Commands[cmdID]
	if !ok {
		a.reject(client, msg.Type, "COMMAND_NOT_FOUND", "Target command does not exist.", cmdID)
		return
	}
	cmd := existing.Clone()
	cmd.Set("isDeleted", msg.Type == "undo-cmd")
	if !a.persistCommand(client, msg.Type, cmd, mutationOptions{Barrier: true, UserID: client.UserID}) {
		return
	}
	slog.Debug("room command", "room", a.roomID, "type", msg.Type, "cmd", cmdID, "user", client.UserID)
	a.metrics.Commands.Add(1)
	data := withTrustedIdentity(client, msg.Data)
	data["cmd"] = cmd.Snapshot()
	data["roomSeq"] = cmd.Get("roomSeq")
	a.recordAndBroadcast("", msg.Type, data, Envelope{Type: msg.Type, Data: data}, nil)
	a.ack(client, "committed", data)
}

func (a *Actor) handleDelete(client ClientInfo, msg clientEventMessage) {
	cmdID := domain.String(msg.Data["cmdId"])
	if !a.persistDelete(client, "delete-cmd", cmdID, mutationOptions{Barrier: true, UserID: client.UserID}) {
		return
	}
	slog.Debug("room command", "room", a.roomID, "type", "delete-cmd", "cmd", cmdID, "user", client.UserID)
	a.metrics.Commands.Add(1)
	msg.Data["roomSeq"] = a.state.RoomSeq
	a.recordAndBroadcast(client.ID, "delete-cmd", msg.Data, Envelope{Type: "delete-cmd", Data: msg.Data}, nil)
	a.ack(client, "committed", msg.Data)
}

func (a *Actor) handlePageAdd(client ClientInfo, msg clientEventMessage) {
	roomSeq, ok := a.persistPageAdd(client, mutationOptions{Barrier: true, UserID: client.UserID})
	if !ok {
		return
	}
	data := withTrustedIdentity(client, msg.Data)
	data["totalPages"] = a.state.Room.TotalPage
	data["roomSeq"] = roomSeq
	slog.Info("page added", "room", a.roomID, "totalPages", a.state.Room.TotalPage, "user", client.UserID)
	a.metrics.Commands.Add(1)
	a.recordAndBroadcast(client.ID, "cmd-page-add", data, Envelope{Type: "cmd-page-add", Data: data}, nil)
	a.ack(client, "committed", data)
}

func (a *Actor) reject(client ClientInfo, opType, code, reason, cmdID string) {
	slog.Warn("operation rejected", "room", a.roomID, "op", opType, "code", code, "cmd", cmdID, "user", client.UserID)
	sendOutbound(client.Send, Outbound{JSON: Envelope{Type: "op-rejected", Data: map[string]any{
		"opType": opType, "code": code, "reason": reason, "cmdId": cmdID, "roomId": a.roomID, "shouldRefresh": true,
	}}})
}

func withTrustedIdentity(client ClientInfo, data map[string]any) map[string]any {
	out := make(map[string]any, len(data)+3)
	for key, value := range data {
		out[key] = value
	}
	out["userId"] = client.UserID
	out["userName"] = client.UserName
	out["username"] = client.UserName
	return out
}
