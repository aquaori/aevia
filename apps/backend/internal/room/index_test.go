package room

import (
	"testing"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func TestPagePointIndexAppendsOnlyNewPoints(t *testing.T) {
	cmd := domain.NewCommand(map[string]any{
		"id":        "cmd-1",
		"type":      "path",
		"tool":      "pen",
		"color":     "#111111",
		"size":      3.0,
		"userId":    "user-1",
		"pageId":    0,
		"isDeleted": false,
		"points": []domain.Point{
			{X: 0.1, Y: 0.1, P: 0.5, Lamport: 1},
			{X: 0.2, Y: 0.2, P: 0.5, Lamport: 2},
		},
	})
	idx := NewPagePointIndex([]domain.Command{cmd})

	cmd.SetPoints(append(cmd.Points(), domain.Point{X: 0.3, Y: 0.3, P: 0.5, Lamport: 3}))
	idx.Upsert(cmd)

	points := idx.PagePoints([]int{0})
	if len(points) != 3 {
		t.Fatalf("expected 3 indexed points, got %d", len(points))
	}
	if points[2].PointIndex != 2 || points[2].Lamport != 3 {
		t.Fatalf("expected appended point at index 2, got index=%d lamport=%v", points[2].PointIndex, points[2].Lamport)
	}
}

func TestPagePointIndexRebuildsSameLengthUpdates(t *testing.T) {
	cmd := domain.NewCommand(map[string]any{
		"id":        "cmd-1",
		"type":      "path",
		"tool":      "pen",
		"color":     "#111111",
		"size":      3.0,
		"userId":    "user-1",
		"pageId":    0,
		"isDeleted": false,
		"points": []domain.Point{
			{X: 0.1, Y: 0.1, P: 0.5, Lamport: 1},
			{X: 0.2, Y: 0.2, P: 0.5, Lamport: 2},
		},
	})
	idx := NewPagePointIndex([]domain.Command{cmd})

	cmd.SetPoints([]domain.Point{
		{X: 0.4, Y: 0.4, P: 0.5, Lamport: 1},
		{X: 0.5, Y: 0.5, P: 0.5, Lamport: 2},
	})
	idx.Upsert(cmd)

	points := idx.PagePoints([]int{0})
	if len(points) != 2 {
		t.Fatalf("expected 2 rebuilt points, got %d", len(points))
	}
	if points[0].X != 0.4 || points[1].X != 0.5 {
		t.Fatalf("expected rebuilt coordinates, got %v and %v", points[0].X, points[1].X)
	}
}

func TestPagePointIndexProjectsV2PathFragmentsIntoOrderedPointStream(t *testing.T) {
	create := domain.NewCommand(map[string]any{
		"id": "create-op", "type": "scene-op", "userId": "user-1", "pageId": 0,
		"sceneOperation": map[string]any{
			"opId": "create-op", "elementId": "stroke-1", "pageId": 0, "kind": "element.create",
			"payload": map[string]any{
				"descriptor": map[string]any{
					"elementKind": "path", "recipeId": "stroke", "toolId": "highlighter",
					"style": map[string]any{"color": "#ff0", "size": 12.0},
				},
				"points": []any{map[string]any{"x": 0.1, "y": 0.2, "p": 0.5, "lamport": 1.0}},
			},
		},
	})
	appendCommand := domain.NewCommand(map[string]any{
		"id": "append-op", "type": "scene-op", "userId": "user-1", "pageId": 0,
		"sceneOperation": map[string]any{
			"opId": "append-op", "elementId": "stroke-1", "pageId": 0, "kind": "element.append",
			"payload": map[string]any{
				"sourceStart": 1.0,
				"points": []any{
					map[string]any{"x": 0.2, "y": 0.3, "p": 0.5, "lamport": 2.0},
					map[string]any{"x": 0.3, "y": 0.4, "p": 0.5, "lamport": 3.0},
				},
			},
		},
	})

	// Append intentionally precedes create to cover persisted map iteration.
	idx := NewPagePointIndex([]domain.Command{appendCommand, create})
	points := idx.PagePoints([]int{0})
	if len(points) != 3 {
		t.Fatalf("expected 3 projected points, got %d", len(points))
	}
	if points[0].CmdID != "stroke-1" || points[0].OrderOpID != "create-op" || points[0].PointIndex != 0 {
		t.Fatalf("unexpected create point: %+v", points[0])
	}
	if points[1].OrderOpID != "append-op" || points[1].PointIndex != 1 || points[1].Tool != "highlighter" {
		t.Fatalf("unexpected append point: %+v", points[1])
	}
}

func TestInitRenderPointsStartAfterEffectivePageClear(t *testing.T) {
	pathCommand := func(id string, lamport float64, x float64) domain.Command {
		return domain.NewCommand(map[string]any{
			"id": id, "type": "scene-op", "userId": "user-1", "pageId": 0, "lamport": lamport,
			"sceneOperation": map[string]any{
				"opId": id, "elementId": id, "pageId": 0, "lamport": lamport,
				"historyGroupId": id, "kind": "element.create",
				"payload": map[string]any{
					"descriptor": map[string]any{
						"elementKind": "path", "recipeId": "stroke", "toolId": "pen",
						"style": map[string]any{"color": "#000", "size": 4.0},
					},
					"points": []any{map[string]any{"x": x, "y": 0.2, "p": 0.5, "lamport": lamport}},
				},
			},
		})
	}
	before := pathCommand("before", 1, 0.1)
	clear := domain.NewCommand(map[string]any{
		"id": "clear", "type": "scene-op", "userId": "user-1", "pageId": 0, "lamport": 2.0,
		"sceneOperation": map[string]any{
			"opId": "clear", "elementId": "page:0", "pageId": 0, "lamport": 2.0,
			"historyGroupId": "clear", "kind": "page.clear",
			"payload": map[string]any{"before": map[string]any{
				"lamport": 2.0, "opId": "clear", "sourceIndex": 0.0, "subIndex": 0.0,
			}},
		},
	})
	after := pathCommand("after", 3, 0.8)
	state := NewState(domain.Room{RoomID: "room", TotalPage: 1}, []domain.Command{before, clear, after})

	points := state.Index.VisiblePagePoints([]int{0}, state.ClearBefore)
	if len(points) != 1 || points[0].CmdID != "after" {
		t.Fatalf("expected only post-clear points, got %+v", points)
	}

	toggle := domain.NewCommand(map[string]any{
		"id": "undo-clear", "type": "scene-op", "userId": "user-1", "pageId": 0, "lamport": 4.0,
		"sceneOperation": map[string]any{
			"opId": "undo-clear", "elementId": "page:0", "pageId": 0, "lamport": 4.0,
			"historyGroupId": "undo-clear", "kind": "history.toggle",
			"payload": map[string]any{"targetHistoryGroupId": "clear", "enabled": false},
		},
	})
	state.UpsertCommand(toggle)
	points = state.Index.VisiblePagePoints([]int{0}, state.ClearBefore)
	if len(points) != 2 {
		t.Fatalf("expected clear undo to restore both paths, got %+v", points)
	}
}
