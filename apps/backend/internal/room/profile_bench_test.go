package room

import (
	"fmt"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/domain"
)

func BenchmarkProfileSnapshotBuild(b *testing.B) {
	cfg := config.Config{
		InitFlatPointChunkSize: 2048,
		InitCommandChunkSize:   32,
		InitPreloadPageCount:   1,
	}
	builder := NewSnapshotBuilder(cfg)
	for _, scale := range []int{10000, 50000, 100000} {
		b.Run(fmt.Sprint(scale), func(b *testing.B) {
			roomData := domain.Room{RoomID: "bench-room", Name: "bench", TotalPage: 3, DurableSeq: 100}
			commands := make([]domain.Command, 0, scale/50)
			for command := 0; command < scale/50; command++ {
				points := make([]domain.Point, 50)
				for i := range points {
					points[i] = domain.Point{X: float64(i) / 50, Y: float64(command%100) / 100, P: 0.5, Lamport: float64(command*50 + i)}
				}
				commands = append(commands, domain.NewCommand(map[string]any{
					"id": fmt.Sprintf("cmd-%06d", command), "type": "path", "pageId": 0, "userId": "u1",
					"lamport": float64(command + 1), "points": points,
				}))
			}
			state := NewState(roomData, commands)
			b.Run("cold_build", func(b *testing.B) {
				b.ReportAllocs()
				for n := 0; n < b.N; n++ {
					coldBuilder := NewSnapshotBuilder(cfg)
					stream := coldBuilder.Init(state, 0)
					if len(stream.RenderChunks) == 0 || len(stream.CommandChunks) == 0 {
						b.Fatal("empty snapshot stream")
					}
				}
			})
			b.Run("checkpoint_hit", func(b *testing.B) {
				builder.Init(state, 0)
				b.ReportAllocs()
				b.ResetTimer()
				for n := 0; n < b.N; n++ {
					stream := builder.Init(state, 0)
					if len(stream.RenderChunks) == 0 || len(stream.CommandChunks) == 0 {
						b.Fatal("empty snapshot stream")
					}
				}
			})
		})
	}
}

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
