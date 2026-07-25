package storage

import (
	"context"
	"log/slog"
	"os"
	"time"
)

func (s *Store) startMaintenance() {
	ctx, cancel := context.WithCancel(context.Background())
	s.maintenance = cancel
	go func() {
		defer close(s.done)
		ticker := time.NewTicker(s.cfg.WALCheckpointInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.observeAndCheckpoint(ctx)
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (s *Store) observeAndCheckpoint(ctx context.Context) {
	size := s.walSize()
	s.wal.SizeBytes.Store(size)
	if size < s.cfg.WALCheckpointBytes {
		return
	}
	mode := "PASSIVE"
	if size >= s.cfg.WALTruncateBytes {
		mode = "TRUNCATE"
	}
	if err := s.Checkpoint(ctx, mode); err != nil {
		s.wal.CheckpointFailures.Add(1)
		slog.Warn("wal checkpoint failed", "mode", mode, "sizeBytes", size, "error", err)
	}
}

func (s *Store) Checkpoint(ctx context.Context, mode string) error {
	if mode == "" {
		mode = "PASSIVE"
	}
	started := time.Now()
	var busy, logFrames, checkpointed int64
	err := s.db.QueryRowContext(ctx, "PRAGMA wal_checkpoint("+mode+")").Scan(&busy, &logFrames, &checkpointed)
	s.wal.LastCheckpointAt.Store(time.Now().UnixMilli())
	s.wal.LastCheckpointMs.Store(time.Since(started).Milliseconds())
	s.wal.LastCheckpointBusy.Store(busy)
	s.wal.LastCheckpointLog.Store(logFrames)
	s.wal.LastCheckpointDone.Store(checkpointed)
	s.wal.LastCheckpointMode.Store(mode)
	s.wal.SizeBytes.Store(s.walSize())
	return err
}

func (s *Store) walSize() int64 {
	info, err := os.Stat(s.cfg.DBPath + "-wal")
	if err != nil {
		return 0
	}
	return info.Size()
}
