package gateway

import (
	"math"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

const sceneSchemaVersion = 2

var sceneKinds = map[string]bool{
	"element.create":    true,
	"element.append":    true,
	"element.transform": true,
	"element.style":     true,
	"element.erase":     true,
	"element.delete":    true,
	"text.patch":        true,
	"history.toggle":    true,
	"page.clear":        true,
}

var sceneRecipes = map[string]bool{
	"stroke": true,
	"shape":  true,
	"glyph":  true,
	"bitmap": true,
}

var legacySceneMutationTypes = map[string]bool{
	"cmd-start":        true,
	"cmd-update":       true,
	"cmd-stop":         true,
	"undo-cmd":         true,
	"redo-cmd":         true,
	"delete-cmd":       true,
	"cmd-batch-move":   true,
	"cmd-batch-update": true,
	"cmd-batch-stop":   true,
}

var elementRecipe = map[string]string{
	"path":    "stroke",
	"shape":   "shape",
	"text":    "glyph",
	"sticky":  "glyph",
	"sticker": "bitmap",
}

var strokePatterns = map[string]bool{
	"": true, "solid": true, "dashed": true, "dotted": true, "dash-dot": true, "double": true,
}

func validateSceneCommand(c *wsClient, typ string, data map[string]any) (string, string, bool) {
	if legacySceneMutationTypes[typ] {
		return "UPGRADE_REQUIRED", "This room accepts schemaVersion 2 scene operations only.", false
	}
	if typ != "push-cmd" {
		return "", "", true
	}
	cmd, ok := data["cmd"].(map[string]any)
	if !ok || stringValue(cmd["type"]) != "scene-op" {
		return "UPGRADE_REQUIRED", "New board writes must use schemaVersion 2 scene operations.", false
	}
	if intValue(cmd["schemaVersion"]) != sceneSchemaVersion {
		return "UPGRADE_REQUIRED", "Scene operation schemaVersion 2 is required.", false
	}
	op, ok := cmd["sceneOperation"].(map[string]any)
	if !ok || intValue(op["schemaVersion"]) != sceneSchemaVersion {
		return "UPGRADE_REQUIRED", "Scene operation schemaVersion 2 is required.", false
	}
	if !sameNonEmptyString(op["actorId"], c.claims.UserID) || !sameNonEmptyString(op["roomId"], c.claims.RoomID) {
		return "INVALID_SCENE_OPERATION", "Scene operation identity does not match the room session.", false
	}
	if !validID(op["opId"]) || !validID(op["elementId"]) || !validID(op["historyGroupId"]) {
		return "INVALID_SCENE_OPERATION", "Scene operation identifiers are missing or invalid.", false
	}
	pageID, pageOK := finiteNumber(op["pageId"])
	lamport, lamportOK := finiteNumber(op["lamport"])
	if !pageOK || pageID < 0 || pageID != math.Trunc(pageID) || !lamportOK || lamport < 0 {
		return "INVALID_SCENE_OPERATION", "Scene operation pageId or lamport is invalid.", false
	}
	cmdPageID, cmdPageOK := finiteNumber(cmd["pageId"])
	cmdLamport, cmdLamportOK := finiteNumber(cmd["lamport"])
	if stringValue(cmd["id"]) != stringValue(op["opId"]) ||
		!sameNonEmptyString(cmd["userId"], c.claims.UserID) ||
		!sameNonEmptyString(cmd["roomId"], c.claims.RoomID) ||
		!cmdPageOK || cmdPageID != pageID || !cmdLamportOK || cmdLamport != lamport {
		return "INVALID_SCENE_OPERATION", "Command and scene operation envelopes do not match.", false
	}
	kind := stringValue(op["kind"])
	if !sceneKinds[kind] {
		return "UNSUPPORTED_SCENE_OPERATION", "Scene operation kind is not supported.", false
	}
	payload, ok := op["payload"].(map[string]any)
	if !ok {
		return "INVALID_SCENE_OPERATION", "Scene operation payload is missing.", false
	}
	return validateScenePayload(kind, payload)
}

func validateScenePayload(kind string, payload map[string]any) (string, string, bool) {
	switch kind {
	case "element.create":
		descriptor, ok := payload["descriptor"].(map[string]any)
		if !ok {
			return "INVALID_SCENE_OPERATION", "Element descriptor is missing.", false
		}
		recipeID := stringValue(descriptor["recipeId"])
		elementKind := stringValue(descriptor["elementKind"])
		if !sceneRecipes[recipeID] {
			return "UNSUPPORTED_RECIPE", "Primitive recipe is not supported by this server.", false
		}
		if !validID(descriptor["toolId"]) || elementRecipe[elementKind] != recipeID {
			return "INVALID_SCENE_OPERATION", "Element kind or tool id is invalid.", false
		}
		if style, ok := descriptor["style"].(map[string]any); !ok || !validSceneStyle(style) {
			return "INVALID_SCENE_OPERATION", "Element style size is invalid.", false
		}
		if (elementKind == "text" || elementKind == "sticky") && len(stringValue(descriptor["text"])) > 10000 {
			return "INVALID_SCENE_OPERATION", "Text content is too long.", false
		}
		if box := descriptor["box"]; box != nil && !validBox(box) {
			return "INVALID_SCENE_OPERATION", "Element bounds are invalid.", false
		}
		if elementKind == "path" && payload["points"] != nil {
			points := payload["points"]
			_, count, isArray := scenePointArray(points)
			if !isArray || (count > 0 && !validPoints(points)) {
				return "INVALID_SCENE_OPERATION", "Element create points are invalid.", false
			}
		}
		if complete := payload["isComplete"]; complete != nil {
			if _, ok := complete.(bool); !ok {
				return "INVALID_SCENE_OPERATION", "Element completion state is invalid.", false
			}
		}
	case "element.append":
		_, pointCount, pointsOK := scenePointArray(payload["points"])
		complete, _ := payload["isComplete"].(bool)
		sourceStart, sourceOK := finiteNumber(payload["sourceStart"])
		if (payload["points"] != nil && !pointsOK) || !sourceOK || sourceStart < 0 || sourceStart != math.Trunc(sourceStart) || (pointCount == 0 && !complete) || (pointCount > 0 && !validPoints(payload["points"])) {
			return "INVALID_SCENE_OPERATION", "Element append points are invalid.", false
		}
	case "element.transform":
		targets := anySlice(payload["targets"])
		if len(targets) == 0 {
			return "INVALID_SCENE_OPERATION", "Transform targets are empty.", false
		}
		for _, raw := range targets {
			target, ok := raw.(map[string]any)
			if !ok || !validID(target["elementId"]) || !validMatrix(target["deltaMatrix"]) {
				return "INVALID_SCENE_OPERATION", "Transform target or matrix is invalid.", false
			}
		}
	case "element.style":
		style, ok := payload["style"].(map[string]any)
		if !ok || !validSceneStylePatch(style) {
			return "INVALID_SCENE_OPERATION", "Element style patch is invalid.", false
		}
	case "element.erase":
		targets := anySlice(payload["targets"])
		if len(targets) == 0 {
			return "INVALID_SCENE_OPERATION", "Erase targets are empty.", false
		}
		for _, raw := range targets {
			target, ok := raw.(map[string]any)
			whole, _ := target["eraseWhole"].(bool)
			intervals := anySlice(target["intervals"])
			if !ok || !validID(target["elementId"]) || !validEraseIntervals(target["intervals"]) ||
				(!whole && (!validID(target["atomId"]) || len(intervals) == 0)) {
				return "INVALID_SCENE_OPERATION", "Erase target intervals are invalid.", false
			}
		}
	case "element.delete":
		ids := anySlice(payload["elementIds"])
		if len(ids) == 0 {
			return "INVALID_SCENE_OPERATION", "Delete targets are empty.", false
		}
		for _, id := range ids {
			if !validID(id) {
				return "INVALID_SCENE_OPERATION", "Delete target id is invalid.", false
			}
		}
	case "text.patch":
		patches := anySlice(payload["patches"])
		if len(patches) == 0 {
			return "INVALID_SCENE_OPERATION", "Text patches are empty.", false
		}
		for _, raw := range patches {
			patch, ok := raw.(map[string]any)
			if !ok || !validID(patch["charId"]) {
				return "INVALID_SCENE_OPERATION", "Text patch is invalid.", false
			}
			switch stringValue(patch["type"]) {
			case "insert":
				grapheme := stringValue(patch["grapheme"])
				if grapheme == "" || len(grapheme) > 128 || (patch["afterId"] != nil && !validID(patch["afterId"])) {
					return "INVALID_SCENE_OPERATION", "Text insert patch is invalid.", false
				}
			case "delete":
			default:
				return "INVALID_SCENE_OPERATION", "Text patch type is invalid.", false
			}
		}
	case "history.toggle":
		if !validID(payload["targetHistoryGroupId"]) {
			return "INVALID_SCENE_OPERATION", "History group id is invalid.", false
		}
		if _, ok := payload["enabled"].(bool); !ok {
			return "INVALID_SCENE_OPERATION", "History toggle state is invalid.", false
		}
	case "page.clear":
		if !validOrderKey(payload["before"]) {
			return "INVALID_SCENE_OPERATION", "Page clear order key is invalid.", false
		}
	}
	return "", "", true
}

func scenePointArray(value any) (any, int, bool) {
	switch points := value.(type) {
	case []any:
		return points, len(points), true
	case []domain.Point:
		return points, len(points), true
	default:
		return nil, 0, false
	}
}

func validMatrix(value any) bool {
	values := anySlice(value)
	if len(values) != 6 {
		return false
	}
	matrix := make([]float64, 6)
	for index, raw := range values {
		value, ok := finiteNumber(raw)
		if !ok || math.Abs(value) > 1e6 {
			return false
		}
		matrix[index] = value
	}
	return math.Abs(matrix[0]*matrix[3]-matrix[1]*matrix[2]) > 1e-12
}

func validSceneStyle(style map[string]any) bool {
	if !validFiniteRange(style["size"], 0.1, 1024) {
		return false
	}
	color := stringValue(style["color"])
	if len(color) == 0 || len(color) > 128 || !strokePatterns[stringValue(style["strokePattern"])] {
		return false
	}
	if opacity := style["opacity"]; opacity != nil && !validFiniteRange(opacity, 0, 1) {
		return false
	}
	if fontSize := style["fontSize"]; fontSize != nil && !validFiniteRange(fontSize, 1, 512) {
		return false
	}
	if fontFamily := style["fontFamily"]; fontFamily != nil && len(stringValue(fontFamily)) > 256 {
		return false
	}
	if fontWeight := style["fontWeight"]; fontWeight != nil {
		value, ok := finiteNumber(fontWeight)
		if !ok || (value != 400 && value != 700) {
			return false
		}
	}
	if textAlign := style["textAlign"]; textAlign != nil {
		value := stringValue(textAlign)
		if value != "left" && value != "center" && value != "right" {
			return false
		}
	}
	return true
}

func validSceneStylePatch(style map[string]any) bool {
	if len(style) == 0 {
		return false
	}
	if size := style["size"]; size != nil && !validFiniteRange(size, 0.1, 1024) {
		return false
	}
	if color := style["color"]; color != nil {
		value := stringValue(color)
		if len(value) == 0 || len(value) > 128 {
			return false
		}
	}
	if fillColor := style["fillColor"]; fillColor != nil && len(stringValue(fillColor)) > 128 {
		return false
	}
	if pattern := style["strokePattern"]; pattern != nil && !strokePatterns[stringValue(pattern)] {
		return false
	}
	if opacity := style["opacity"]; opacity != nil && !validFiniteRange(opacity, 0, 1) {
		return false
	}
	if fontSize := style["fontSize"]; fontSize != nil && !validFiniteRange(fontSize, 1, 512) {
		return false
	}
	if fontFamily := style["fontFamily"]; fontFamily != nil && len(stringValue(fontFamily)) > 256 {
		return false
	}
	if fontWeight := style["fontWeight"]; fontWeight != nil {
		value, ok := finiteNumber(fontWeight)
		if !ok || (value != 400 && value != 700) {
			return false
		}
	}
	if textAlign := style["textAlign"]; textAlign != nil {
		value := stringValue(textAlign)
		if value != "left" && value != "center" && value != "right" {
			return false
		}
	}
	return true
}

func validBox(value any) bool {
	box, ok := value.(map[string]any)
	if !ok {
		return false
	}
	minX, minXOK := finiteNumber(box["minX"])
	minY, minYOK := finiteNumber(box["minY"])
	maxX, maxXOK := finiteNumber(box["maxX"])
	maxY, maxYOK := finiteNumber(box["maxY"])
	width, widthOK := finiteNumber(box["width"])
	height, heightOK := finiteNumber(box["height"])
	return minXOK && minYOK && maxXOK && maxYOK && widthOK && heightOK &&
		minX >= -16 && minY >= -16 && maxX <= 16 && maxY <= 16 &&
		maxX >= minX && maxY >= minY && math.Abs(width-(maxX-minX)) <= 1e-9 && math.Abs(height-(maxY-minY)) <= 1e-9
}

func validOrderKey(value any) bool {
	key, ok := value.(map[string]any)
	if !ok || !validID(key["opId"]) {
		return false
	}
	lamport, lamportOK := finiteNumber(key["lamport"])
	sourceIndex, sourceOK := finiteNumber(key["sourceIndex"])
	subIndex, subOK := finiteNumber(key["subIndex"])
	return lamportOK && lamport >= 0 && sourceOK && sourceIndex >= 0 && sourceIndex == math.Trunc(sourceIndex) &&
		subOK && subIndex == math.Trunc(subIndex)
}

func validEraseIntervals(value any) bool {
	if value == nil {
		return true
	}
	for _, raw := range anySlice(value) {
		interval, ok := raw.(map[string]any)
		if !ok {
			return false
		}
		start, startOK := finiteNumber(interval["start"])
		end, endOK := finiteNumber(interval["end"])
		if !startOK || !endOK || start != math.Trunc(start) || end != math.Trunc(end) || start < 0 || start >= end || end > 65535 {
			return false
		}
	}
	return true
}

func validPoints(value any) bool {
	switch points := value.(type) {
	case []domain.Point:
		if len(points) == 0 {
			return false
		}
		for _, point := range points {
			if point.X < -16 || point.X > 16 || point.Y < -16 || point.Y > 16 || point.P < 0 || point.P > 1 || math.IsNaN(point.Lamport) || math.IsInf(point.Lamport, 0) || point.Lamport < 0 {
				return false
			}
		}
		return true
	case []any:
		if len(points) == 0 {
			return false
		}
		for _, raw := range points {
			point, ok := raw.(map[string]any)
			if !ok || !validFiniteRange(point["x"], -16, 16) || !validFiniteRange(point["y"], -16, 16) || !validFiniteRange(point["p"], 0, 1) {
				return false
			}
			if lamport, ok := finiteNumber(point["lamport"]); !ok || lamport < 0 {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func validID(value any) bool {
	text := stringValue(value)
	return len(text) > 0 && len(text) <= 256
}

func sameNonEmptyString(value any, expected string) bool {
	return expected != "" && stringValue(value) == expected
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func intValue(value any) int {
	number, ok := finiteNumber(value)
	if !ok || number != math.Trunc(number) {
		return -1
	}
	return int(number)
}

func finiteNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	return number, ok && !math.IsNaN(number) && !math.IsInf(number, 0)
}

func validFiniteRange(value any, min, max float64) bool {
	number, ok := finiteNumber(value)
	return ok && number >= min && number <= max
}
