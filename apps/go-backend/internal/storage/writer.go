package storage

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"collaborative-whiteboard/apps/go-backend/internal/config"
	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

type Writer struct {
	db       *sql.DB
	cfg      config.Config
	writes   chan writeRequest
	done     chan struct{}
	closing  chan struct{}
	degraded atomic.Bool
}

type writeRequest struct {
	kind           string
	roomID         string
	cmdID          string
	cmd            domain.Command
	pageID         *int
	totalPageDelta int
	roomSeq        uint64
	opID           string
	userID         string
	response       string
	result         chan error
}

func NewWriter(db *sql.DB, cfg config.Config) *Writer {
	writer := &Writer{
		db: db, cfg: cfg,
		writes:  make(chan writeRequest, cfg.DBBatchSize*16),
		done:    make(chan struct{}),
		closing: make(chan struct{}),
	}
	go writer.loop()
	return writer
}

func (w *Writer) Close() {
	select {
	case <-w.closing:
	default:
		close(w.closing)
	}
	<-w.done
}

func (w *Writer) SaveCommand(roomID string, cmd domain.Command, wait bool) error {
	return w.enqueue(writeRequest{kind: "save", roomID: roomID, cmd: cmd.Snapshot()}, wait)
}

func (w *Writer) SaveCommandAtSeq(roomID string, cmd domain.Command, roomSeq uint64, wait bool) error {
	return w.enqueue(writeRequest{kind: "save", roomID: roomID, cmd: cmd.Snapshot(), roomSeq: roomSeq}, wait)
}

func (w *Writer) DeleteCommand(roomID, cmdID string, wait bool) error {
	return w.enqueue(writeRequest{kind: "delete", roomID: roomID, cmdID: cmdID}, wait)
}

func (w *Writer) DeleteCommandAtSeq(roomID, cmdID string, roomSeq uint64, wait bool) error {
	return w.enqueue(writeRequest{kind: "delete", roomID: roomID, cmdID: cmdID, roomSeq: roomSeq}, wait)
}

func (w *Writer) ClearCommands(roomID string, pageID *int, wait bool) error {
	return w.enqueue(writeRequest{kind: "clear", roomID: roomID, pageID: pageID}, wait)
}

func (w *Writer) ClearCommandsAtSeq(roomID string, pageID *int, roomSeq uint64, wait bool) error {
	return w.enqueue(writeRequest{kind: "clear", roomID: roomID, pageID: pageID, roomSeq: roomSeq}, wait)
}

func (w *Writer) IncrementPage(roomID string, wait bool) error {
	return w.enqueue(writeRequest{kind: "increment-page", roomID: roomID, totalPageDelta: 1}, wait)
}

func (w *Writer) IncrementPageAtSeq(roomID string, roomSeq uint64, wait bool) error {
	return w.enqueue(writeRequest{kind: "increment-page", roomID: roomID, totalPageDelta: 1, roomSeq: roomSeq}, wait)
}

func (w *Writer) SaveReceipt(roomID, opID, userID string, roomSeq uint64, response string, wait bool) error {
	if opID == "" {
		return nil
	}
	return w.enqueue(writeRequest{
		kind: "receipt", roomID: roomID, opID: opID, userID: userID,
		roomSeq: roomSeq, response: response,
	}, wait)
}

func (w *Writer) Flush() error {
	return w.enqueue(writeRequest{kind: "flush"}, true)
}

func (w *Writer) IsDegraded() bool {
	return w.degraded.Load()
}

func (w *Writer) QueueLen() int {
	return len(w.writes)
}

func (w *Writer) QueueCap() int {
	return cap(w.writes)
}

func (w *Writer) enqueue(req writeRequest, wait bool) error {
	if wait {
		req.result = make(chan error, 1)
	}
	select {
	case w.writes <- req:
		if req.result != nil {
			return <-req.result
		}
		return nil
	case <-w.closing:
		return errors.New("writer is closing")
	}
}

func (w *Writer) loop() {
	defer close(w.done)
	ticker := time.NewTicker(w.cfg.DBBatchWindow)
	defer ticker.Stop()

	batch := make([]writeRequest, 0, w.cfg.DBBatchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		results, err := w.applyBatchWithRecovery(context.Background(), batch)
		if err != nil && !isTransientWriteError(err) {
			w.degraded.Store(true)
			slog.Error("database writer degraded", "writes", len(batch), "error", err)
		}
		for index, req := range batch {
			if req.result != nil {
				req.result <- results[index]
			}
		}
		batch = batch[:0]
	}

	for {
		select {
		case req := <-w.writes:
			batch = append(batch, req)
			if len(batch) >= w.cfg.DBBatchSize || req.result != nil {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-w.closing:
			for {
				select {
				case req := <-w.writes:
					batch = append(batch, req)
				default:
					flush()
					return
				}
			}
		}
	}
}

func (w *Writer) applyBatchWithRecovery(ctx context.Context, batch []writeRequest) ([]error, error) {
	results := make([]error, len(batch))
	if err := w.applyBatchWithRetry(ctx, batch); err == nil {
		return results, nil
	} else {
		slog.Warn("database batch write failed", "writes", len(batch), "error", err)
	}

	var firstErr error
	for index, req := range batch {
		err := w.applyBatchWithRetry(ctx, []writeRequest{req})
		results[index] = err
		if err == nil {
			continue
		}
		slog.Warn("database write failed", "kind", req.kind, "room", req.roomID, "cmd", req.cmdID, "error", err)
		if firstErr == nil || (!isTransientWriteError(err) && isTransientWriteError(firstErr)) {
			firstErr = err
		}
	}
	return results, firstErr
}

func (w *Writer) applyBatchWithRetry(ctx context.Context, batch []writeRequest) error {
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		err = w.applyBatch(ctx, batch)
		if err == nil || !isTransientWriteError(err) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 10 * time.Millisecond)
	}
	return err
}

func isTransientWriteError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "database is locked") ||
		strings.Contains(message, "database table is locked") ||
		strings.Contains(message, "busy") ||
		strings.Contains(message, "locked")
}

func (w *Writer) applyBatch(ctx context.Context, batch []writeRequest) error {
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	for _, req := range batch {
		if err := applyWrite(ctx, tx, req); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}
