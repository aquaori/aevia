package room

import (
	"fmt"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func BenchmarkProfilePageIndex(b *testing.B) {
	for _, scale := range []int{10000, 50000, 100000} {
		b.Run(fmt.Sprint(scale), func(b *testing.B) {
			commands := make([]domain.Command, 0, scale/50)
			for command := 0; command < scale/50; command++ {
				points := make([]domain.Point, 50)
				for i := range points {
					points[i] = domain.Point{X: float64(i) / 50, Y: float64(command%100) / 100, P: 0.5, Lamport: float64(command*50 + i)}
				}
				commands = append(commands, domain.NewCommand(map[string]any{"id": fmt.Sprint(command), "type": "path", "pageId": 0, "points": points}))
			}
			testIndex := NewPagePointIndex(commands)
			if len(testIndex.PagePoints([]int{0})) != scale {
				b.Fatal("point count mismatch")
			}
			b.Run("build", func(b *testing.B) {
				b.ReportAllocs()
				for n := 0; n < b.N; n++ {
					NewPagePointIndex(commands)
				}
			})
			b.Run("read", func(b *testing.B) {
				b.ReportAllocs()
				for n := 0; n < b.N; n++ {
					testIndex.PagePoints([]int{0})
				}
			})
		})
	}
}
