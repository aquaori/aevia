package storage

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/domain"
)

func BenchmarkProfileSQLiteTransaction(b *testing.B) {
	for _, size := range []int{1, 16, 64} {
		b.Run(fmt.Sprintf("batch-%d", size), func(b *testing.B) {
			ctx := context.Background()
			store, err := Open(config.Config{
				DBPath: filepath.Join(b.TempDir(), "profile.sqlite"), DBBatchSize: size,
				DBBatchWindow: time.Millisecond, WALCheckpointInterval: time.Hour,
			})
			if err != nil {
				b.Fatal(err)
			}
			defer store.Close()
			if err := store.CreateRoom(ctx, domain.Room{RoomID: "111111", Name: "profile"}); err != nil {
				b.Fatal(err)
			}
			batch := make([]writeRequest, size)
			for i := range batch {
				command := domain.NewCommand(map[string]any{
					"id": fmt.Sprintf("command-%d", i), "type": "path", "pageId": 0, "userId": "fixture",
				})
				batch[i] = writeRequest{kind: "save", roomID: "111111", cmd: command, roomSeq: uint64(i + 1)}
			}
			b.ReportAllocs()
			b.ResetTimer()
			for n := 0; n < b.N; n++ {
				if err := store.writer.applyBatch(ctx, batch); err != nil {
					b.Fatal(err)
				}
			}
			b.StopTimer()
		})
	}
}
