package room

import (
	"encoding/json"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
	"collaborative-whiteboard/apps/go-backend/internal/protocol"
)

func commandFromData(value any) domain.Command {
	if value == nil {
		return nil
	}
	switch raw := value.(type) {
	case domain.Command:
		cmd := raw.Clone()
		cmd.SetPoints(pointsFromAny(cmd.Get("points")))
		return cmd
	case map[string]any:
		return domain.NewCommand(raw)
	}
	return nil
}

func pointsFromAny(value any) []domain.Point {
	switch points := value.(type) {
	case []domain.Point:
		return points
	case []map[string]any:
		out := make([]domain.Point, 0, len(points))
		for _, point := range points {
			out = append(out, pointFromMap(point))
		}
		return out
	case []any:
		out := make([]domain.Point, 0, len(points))
		for _, point := range points {
			if mapped, ok := point.(map[string]any); ok {
				out = append(out, pointFromMap(mapped))
			}
		}
		return out
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var points []domain.Point
	_ = json.Unmarshal(bytes, &points)
	return points
}

func pointFromMap(point map[string]any) domain.Point {
	return domain.Point{
		X:       domain.FloatDefault(point["x"], 0),
		Y:       domain.FloatDefault(point["y"], 0),
		P:       domain.FloatDefault(point["p"], 0),
		Lamport: domain.FloatDefault(point["lamport"], 0),
	}
}

func mapSlice(value any) []map[string]any {
	switch values := value.(type) {
	case []map[string]any:
		return values
	case []any:
		out := make([]map[string]any, 0, len(values))
		for _, value := range values {
			if mapped, ok := value.(map[string]any); ok {
				out = append(out, mapped)
			}
		}
		return out
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var out []map[string]any
	_ = json.Unmarshal(bytes, &out)
	return out
}

func stringSlice(value any) []string {
	switch values := value.(type) {
	case []string:
		return values
	case []any:
		out := make([]string, 0, len(values))
		for _, value := range values {
			if item, ok := value.(string); ok {
				out = append(out, item)
			}
		}
		return out
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var out []string
	_ = json.Unmarshal(bytes, &out)
	return out
}

func encodeCommandUpdate(cmdID string, rawPoints any) []byte {
	if points, ok := rawPoints.([]domain.Point); ok {
		return protocol.EncodeCommandUpdatePoints(cmdID, points)
	}
	points := mapSlice(rawPoints)
	return protocol.EncodeCommandUpdate(cmdID, points)
}
