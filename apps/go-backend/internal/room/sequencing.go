package room

import "collaborative-whiteboard/apps/go-backend/internal/domain"

func (a *Actor) recordAndBroadcast(exclude ClientID, typ string, data map[string]any, json any, binary []byte) {
	roomSeq := uint64(0)
	if value, ok := domain.Int(data["roomSeq"]); ok {
		roomSeq = uint64(value)
	}
	if roomSeq == 0 {
		roomSeq = a.state.RoomSeq
		data["roomSeq"] = roomSeq
	}
	a.state.Deltas.Add(DeltaEvent{RoomSeq: roomSeq, Type: typ, Data: data, Binary: binary})
	a.metrics.Deltas.Add(1)
	a.broadcastExcept(exclude, json, binary)
}

func (a *Actor) ack(client ClientInfo, status string, data map[string]any) {
	sendOutbound(client.Send, Outbound{JSON: Envelope{Type: "ack." + status, Data: map[string]any{
		"roomSeq": data["roomSeq"],
		"cmdId":   data["cmdId"],
		"opId":    data["opId"],
	}}})
}

func (a *Actor) validateAppend(client ClientInfo, opType, cmdID string, cmd domain.Command, points []domain.Point, data map[string]any) bool {
	if len(points) == 0 {
		return true
	}
	fromPointIndex, ok := domain.Int(data["fromPointIndex"])
	if !ok {
		return true
	}
	currentLen := len(cmd.Points())
	if fromPointIndex < currentLen {
		a.ack(client, "accepted", map[string]any{"cmdId": cmdID, "roomSeq": a.state.RoomSeq})
		return false
	}
	if fromPointIndex > currentLen {
		a.reject(client, opType, "POINT_GAP", "Point update has a gap and requires resync.", cmdID)
		return false
	}
	return true
}
