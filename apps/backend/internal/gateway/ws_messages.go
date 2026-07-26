package gateway

import (
	"encoding/json"

	"collaborative-whiteboard/apps/backend/internal/protocol"
	"collaborative-whiteboard/apps/backend/internal/room"
)

type incomingMessage struct {
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

func handleBinaryClientMessage(c *wsClient, payload []byte) {
	msg, err := protocol.DecodeRealtime(payload)
	if err != nil {
		return
	}
	if !c.events.Allow(msg.Type) {
		if !isRealtimeEvent(msg.Type) {
			sendRateRejected(c, msg.Type)
		}
		return
	}
	// The binary frame is the hot path for cmd-update, so it must be size-checked
	// like the JSON path. Skipping it here made WS_MAX_POINTS_PER_UPDATE
	// unenforced for the only transport that actually carries those updates.
	if !c.validateIncomingBinary(msg.Type, msg.Data) {
		sendLimitRejected(c, msg.Type)
		return
	}
	if msg.Binary != nil {
		if err := c.actor.BinaryEvent(c.id, msg.Type, msg.Data, msg.Binary); err != nil {
			sendBusy(c, msg.Type)
		}
		return
	}
	if err := c.actor.Event(c.id, msg.Type, msg.Data, true); err != nil {
		sendBusy(c, msg.Type)
	}
}

func handleTextClientMessage(c *wsClient, payload []byte) {
	var msg incomingMessage
	if json.Unmarshal(payload, &msg) != nil || msg.Type == "" {
		return
	}
	if !c.events.Allow(msg.Type) {
		if !isRealtimeEvent(msg.Type) {
			sendRateRejected(c, msg.Type)
		}
		return
	}
	if !c.validateIncoming(msg.Type, msg.Data) {
		sendLimitRejected(c, msg.Type)
		return
	}
	if msg.Type == "page-change" {
		if err := c.actor.PageChange(c.id, parsePageChange(msg.Data)); err != nil {
			sendBusy(c, msg.Type)
		}
		return
	}
	if err := c.actor.Event(c.id, msg.Type, msg.Data, false); err != nil {
		sendBusy(c, msg.Type)
	}
}

func sendRateRejected(c *wsClient, opType string) {
	select {
	case c.send <- room.Outbound{JSON: room.Envelope{Type: "op-rejected", Data: map[string]any{
		"opType":        opType,
		"code":          "RATE_LIMITED",
		"reason":        "Operation rate exceeds server limits.",
		"shouldRefresh": false,
		"shouldResync":  false,
	}}}:
	default:
	}
}

func sendLimitRejected(c *wsClient, opType string) {
	select {
	case c.send <- room.Outbound{JSON: room.Envelope{Type: "op-rejected", Data: map[string]any{
		"opType":        opType,
		"code":          "PAYLOAD_LIMIT_EXCEEDED",
		"reason":        "Operation payload exceeds server limits.",
		"shouldRefresh": false,
		"shouldResync":  false,
	}}}:
	default:
	}
}

func sendBusy(c *wsClient, opType string) {
	select {
	case c.send <- room.Outbound{JSON: room.Envelope{Type: "op-rejected", Data: map[string]any{
		"opType":        opType,
		"code":          "SERVER_BUSY",
		"reason":        "Room is overloaded. Please retry shortly.",
		"shouldRefresh": false,
		"shouldResync":  false,
	}}}:
	default:
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
