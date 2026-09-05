package gateway

import "collaborative-whiteboard/apps/backend/internal/domain"

// validateIncomingBinary enforces payload limits for decoded binary frames.
// The decoder yields []domain.Point rather than the []any that JSON produces, so
// the point count is read through a type-aware helper.
func (c *wsClient) validateIncomingBinary(typ string, data map[string]any) bool {
	switch typ {
	case "cmd-update", "cmd-stop":
		return decodedPointCount(data["points"]) <= c.maxPointsPerUpdate()
	case "cmd-start", "push-cmd":
		if cmd, ok := data["cmd"].(map[string]any); ok {
			if scene, ok := cmd["sceneOperation"].(map[string]any); ok {
				return c.scenePayloadWithinLimits(scene)
			}
		}
		return decodedPointCount(data["points"]) <= c.maxPointsPerCommand()
	default:
		return true
	}
}

func decodedPointCount(value any) int {
	switch points := value.(type) {
	case []domain.Point:
		return len(points)
	case []any:
		return len(points)
	default:
		return 0
	}
}

func (c *wsClient) validateIncoming(typ string, data map[string]any) bool {
	switch typ {
	case "cmd-update", "cmd-stop":
		return len(pointsFromIncoming(data["points"])) <= c.maxPointsPerUpdate()
	case "cmd-batch-move":
		return len(anySlice(data["cmdIds"])) <= c.maxBatchCommands()
	case "cmd-batch-update", "cmd-batch-stop":
		return len(anySlice(data["updates"])) <= c.maxBatchCommands()
	case "cmd-start", "push-cmd":
		cmd, ok := data["cmd"].(map[string]any)
		if !ok {
			return true
		}
		if scene, ok := cmd["sceneOperation"].(map[string]any); ok {
			return c.scenePayloadWithinLimits(scene)
		}
		return len(pointsFromIncoming(cmd["points"])) <= c.maxPointsPerCommand()
	default:
		return true
	}
}

func (c *wsClient) scenePayloadWithinLimits(operation map[string]any) bool {
	payload, _ := operation["payload"].(map[string]any)
	if payload == nil {
		return false
	}
	count := func(value any) int {
		switch values := value.(type) {
		case []any:
			return len(values)
		case []domain.Point:
			return len(values)
		default:
			return 0
		}
	}
	switch stringValue(operation["kind"]) {
	case "element.create", "element.append":
		return count(payload["points"]) <= c.maxPointsPerCommand()
	case "element.transform", "element.erase":
		return count(payload["targets"]) <= c.maxBatchCommands()
	case "element.delete":
		return count(payload["elementIds"]) <= c.maxBatchCommands()
	case "text.patch":
		return count(payload["patches"]) <= c.maxBatchCommands()
	default:
		return true
	}
}

func pointsFromIncoming(value any) []any {
	return anySlice(value)
}

func anySlice(value any) []any {
	values, ok := value.([]any)
	if !ok {
		return nil
	}
	return values
}

func (c *wsClient) maxPointsPerUpdate() int {
	return c.limits.maxPointsPerUpdate
}

func (c *wsClient) maxPointsPerCommand() int {
	return c.limits.maxPointsPerCommand
}

func (c *wsClient) maxBatchCommands() int {
	return c.limits.maxBatchCommands
}

type wsClientLimits struct {
	maxPointsPerUpdate  int
	maxPointsPerCommand int
	maxBatchCommands    int
}
