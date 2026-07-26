package storage

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
	_ "modernc.org/sqlite"
)

type Store struct {
	db          *sql.DB
	cfg         config.Config
	writer      *Writer
	maintenance context.CancelFunc
	done        chan struct{}
	wal         WALMetrics
}

type WALMetrics struct {
	SizeBytes          atomic.Int64
	LastCheckpointAt   atomic.Int64
	LastCheckpointMs   atomic.Int64
	LastCheckpointBusy atomic.Int64
	LastCheckpointLog  atomic.Int64
	LastCheckpointDone atomic.Int64
	CheckpointFailures atomic.Uint64
	LastCheckpointMode atomic.Value
}

func Open(cfg config.Config) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxIdleTime(time.Minute)

	store := &Store{db: db, cfg: cfg, done: make(chan struct{})}
	if err := store.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	store.writer = NewWriter(db, cfg)
	store.startMaintenance()
	return store, nil
}

func (s *Store) Close() error {
	if s.maintenance != nil {
		s.maintenance()
	}
	if s.done != nil {
		<-s.done
	}
	if s.writer != nil {
		s.writer.Close()
	}
	return s.db.Close()
}

func (s *Store) Flush(ctx context.Context) error {
	if s.writer == nil {
		return nil
	}
	done := make(chan error, 1)
	go func() {
		done <- s.writer.Flush()
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Store) Ready(ctx context.Context) error {
	if s.writer != nil && s.writer.IsDegraded() {
		return errors.New("database writer is degraded")
	}
	var one int
	return s.db.QueryRowContext(ctx, "SELECT 1").Scan(&one)
}

func (s *Store) Metrics() map[string]any {
	queueLen, queueCap := 0, 0
	degraded := false
	if s.writer != nil {
		queueLen = s.writer.QueueLen()
		queueCap = s.writer.QueueCap()
		degraded = s.writer.IsDegraded()
	}
	mode, _ := s.wal.LastCheckpointMode.Load().(string)
	return map[string]any{
		"writer": map[string]any{
			"queueLen": queueLen,
			"queueCap": queueCap,
			"degraded": degraded,
		},
		"wal": map[string]any{
			"sizeBytes":          s.wal.SizeBytes.Load(),
			"lastCheckpointAt":   s.wal.LastCheckpointAt.Load(),
			"lastCheckpointMs":   s.wal.LastCheckpointMs.Load(),
			"lastCheckpointBusy": s.wal.LastCheckpointBusy.Load(),
			"lastCheckpointLog":  s.wal.LastCheckpointLog.Load(),
			"lastCheckpointDone": s.wal.LastCheckpointDone.Load(),
			"checkpointFailures": s.wal.CheckpointFailures.Load(),
			"lastMode":           mode,
		},
	}
}
