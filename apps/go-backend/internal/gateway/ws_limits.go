package gateway

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
		return len(pointsFromIncoming(cmd["points"])) <= c.maxPointsPerCommand()
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
