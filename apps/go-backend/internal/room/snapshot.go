package room

import (
	"encoding/json"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

func snapshotOutbound(msg Outbound) Outbound {
	if msg.JSON != nil {
		msg.JSON = snapshotAny(msg.JSON)
	}
	if msg.Text != nil {
		msg.Text = append([]byte(nil), msg.Text...)
	}
	if msg.Binary != nil {
		msg.Binary = append([]byte(nil), msg.Binary...)
	}
	return msg
}

func freezeJSONOutbound(jsonValue any) Outbound {
	payload, err := json.Marshal(jsonValue)
	if err != nil {
		return Outbound{}
	}
	return Outbound{Text: payload, Frozen: true, Bytes: len(payload)}
}

func snapshotDeltaEvent(event DeltaEvent) DeltaEvent {
	event.Data = snapshotMap(event.Data)
	if event.Binary != nil {
		event.Binary = append([]byte(nil), event.Binary...)
	}
	return event
}

func snapshotAny(value any) any {
	switch v := value.(type) {
	case nil:
		return nil
	case Envelope:
		return Envelope{Type: v.Type, PushType: v.PushType, Data: snapshotMap(v.Data)}
	case domain.Command:
		return v.Snapshot()
	case map[string]any:
		return snapshotMap(v)
	case []domain.Command:
		out := make([]domain.Command, len(v))
		for i, cmd := range v {
			out[i] = cmd.Snapshot()
		}
		return out
	case []domain.Point:
		return append([]domain.Point(nil), v...)
	case []domain.FlatPoint:
		return append([]domain.FlatPoint(nil), v...)
	case []map[string]any:
		out := make([]map[string]any, len(v))
		for i, item := range v {
			out[i] = snapshotMap(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = snapshotAny(item)
		}
		return out
	default:
		return value
	}
}

func snapshotMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = snapshotAny(value)
	}
	return out
}
