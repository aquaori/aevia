package gateway

import (
	"encoding/binary"
	"encoding/json"

	"collaborative-whiteboard/apps/backend/internal/protocol"
	"collaborative-whiteboard/apps/backend/internal/room"
)

type incomingMessage struct {
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

func handleBinaryClientMessage(c *wsClient, payload []byte) {
	if len(payload) >= 4 && binary.BigEndian.Uint32(payload[:4]) == protocol.SceneAppendMagic {
		data, err := protocol.DecodeSceneAppend(payload)
		if err != nil {
			sendSceneRejected(c, "push-cmd", nil, "INVALID_SCENE_OPERATION", "Invalid scene append frame.")
			return
		}
		encoded, err := json.Marshal(incomingMessage{Type: "push-cmd", Data: data})
		if err != nil {
			sendSceneRejected(c, "push-cmd", data, "INVALID_SCENE_OPERATION", "Invalid scene append values.")
			return
		}
		handleTextClientMessage(c, encoded)
		return
	}
	msg, err := protocol.DecodeRealtime(payload)
	if err != nil {
		return
	}
	if !c.events.Allow(msg.Type) {
		if !isRealtimeEvent(msg.Type) {
			sendRateRejected(c, msg.Type, msg.Data)
		}
		return
	}
	// The binary frame is the hot path for cmd-update, so it must be size-checked
	// like the JSON path. Skipping it here made WS_MAX_POINTS_PER_UPDATE
	// unenforced for the only transport that actually carries those updates.
	if !c.validateIncomingBinary(msg.Type, msg.Data) {
		sendLimitRejected(c, msg.Type, msg.Data)
		return
	}
	if code, reason, ok := validateSceneCommand(c, msg.Type, msg.Data); !ok {
		sendSceneRejected(c, msg.Type, msg.Data, code, reason)
		return
	}
	if msg.Binary != nil {
		if err := c.actor.BinaryEvent(c.id, msg.Type, msg.Data, msg.Binary); err != nil {
			sendBusy(c, msg.Type, msg.Data)
		}
		return
	}
	if err := c.actor.Event(c.id, msg.Type, msg.Data, true); err != nil {
		sendBusy(c, msg.Type, msg.Data)
	}
}

func handleTextClientMessage(c *wsClient, payload []byte) {
	var msg incomingMessage
	if json.Unmarshal(payload, &msg) != nil || msg.Type == "" {
		return
	}
	if !c.events.Allow(msg.Type) {
		if !isRealtimeEvent(msg.Type) {
			sendRateRejected(c, msg.Type, msg.Data)
		}
		return
	}
	if !c.validateIncoming(msg.Type, msg.Data) {
		sendLimitRejected(c, msg.Type, msg.Data)
		return
	}
	if code, reason, ok := validateSceneCommand(c, msg.Type, msg.Data); !ok {
		sendSceneRejected(c, msg.Type, msg.Data, code, reason)
		return
	}
	if msg.Type == "page-change" {
		if err := c.actor.PageChange(c.id, parsePageChange(msg.Data)); err != nil {
			sendBusy(c, msg.Type, msg.Data)
		}
		return
	}
	if err := c.actor.Event(c.id, msg.Type, msg.Data, false); err != nil {
		sendBusy(c, msg.Type, msg.Data)
	}
}

func sendRateRejected(c *wsClient, opType string, data map[string]any) {
	select {
	case c.send <- room.Outbound{JSON: room.Envelope{Type: "op-rejected", Data: map[string]any{
		"opType":        opType,
		"cmdId":         rejectedCommandID(data),
		"code":          "RATE_LIMITED",
		"reason":        "Operation rate exceeds server limits.",
		"shouldRefresh": false,
		"shouldResync":  false,
	}}}:
	default:
		c.abortConnection()
	}
}

func sendLimitRejected(c *wsClient, opType string, data map[string]any) {
	select {
	case c.send <- room.Outbound{JSON: room.Envelope{Type: "op-rejected", Data: map[string]any{
		"opType":        opType,
		"cmdId":         rejectedCommandID(data),
		"code":          "PAYLOAD_LIMIT_EXCEEDED",
		"reason":        "Operation payload exceeds server limits.",
		"shouldRefresh": false,
		"shouldResync":  false,
	}}}:
	default:
		c.abortConnection()
	}
}

func sendBusy(c *wsClient, opType string, data map[string]any) {
	select {
	case c.send <- room.Outbound{JSON: room.Envelope{Type: "op-rejected", Data: map[string]any{
		"opType":        opType,
		"cmdId":         rejectedCommandID(data),
		"code":          "SERVER_BUSY",
		"reason":        "Room is overloaded. Please retry shortly.",
		"shouldRefresh": false,
		"shouldResync":  false,
	}}}:
	default:
		c.abortConnection()
	}
}

func rejectedCommandID(data map[string]any) any {
	if cmd, ok := data["cmd"].(map[string]any); ok {
		return cmd["id"]
	}
	return data["cmdId"]
}

func sendSceneRejected(c *wsClient, opType string, data map[string]any, code, reason string) {
	var cmdID any
	var pageID any
	if cmd, ok := data["cmd"].(map[string]any); ok {
		cmdID = cmd["id"]
		pageID = cmd["pageId"]
	}
	select {
	case c.send <- room.Outbound{JSON: room.Envelope{Type: "op-rejected", Data: map[string]any{
		"opType": opType, "code": code, "reason": reason,
		"cmdId": cmdID, "pageId": pageID,
		"shouldRefresh": false, "shouldResync": false,
	}}}:
	default:
		c.abortConnection()
	}
}

func parsePageChange(data map[string]any) room.PageChangeRequest {
	return room.PageChangeRequest{
		RequestID:           intNumber(data["requestId"]),
		PrevPageID:          optionalInt(data["prevPageId"]),
		NextPageID:          optionalInt(data["nextPageId"]),
		PageID:              optionalInt(data["pageId"]),
		ClientLoadedPageIDs: intSlice(data["clientLoadedPageIds"]),
	}
}

func optionalInt(v any) *int {
	switch x := v.(type) {
	case float64:
		value := int(x)
		return &value
	case int:
		return &x
	default:
		return nil
	}
}

func intNumber(v any) int {
	if p := optionalInt(v); p != nil {
		return *p
	}
	return 0
}

func intSlice(v any) []int {
	values, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]int, 0, len(values))
	for _, value := range values {
		out = append(out, intNumber(value))
	}
	return out
}
