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
