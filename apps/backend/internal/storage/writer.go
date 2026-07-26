package storage

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strings"
	"sync"
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

	// onAsyncFailure is notified when a fire-and-forget write fails. Without it
	// those errors were dropped entirely: the room had already applied the
	// mutation in memory, so clients saw geometry that would vanish on restart.
	asyncFailureMu sync.RWMutex
	onAsyncFailure func(roomID string, err error)
}

type writeRequest struct {
	kind           string
	roomID         string
	cmdID          string
	cmd            domain.Command
	pageID         *int
	totalPageDelta int
	roomSeq        uint64
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

func (w *Writer) SaveCommandAtSeq(roomID string, cmd domain.Command, roomSeq uint64, wait bool) error {
	return w.enqueue(writeRequest{kind: "save", roomID: roomID, cmd: cmd.Snapshot(), roomSeq: roomSeq}, wait)
}

func (w *Writer) DeleteCommandAtSeq(roomID, cmdID string, roomSeq uint64, wait bool) error {
	return w.enqueue(writeRequest{kind: "delete", roomID: roomID, cmdID: cmdID, roomSeq: roomSeq}, wait)
}

func (w *Writer) ClearCommandsAtSeq(roomID string, pageID *int, roomSeq uint64, wait bool) error {
	return w.enqueue(writeRequest{kind: "clear", roomID: roomID, pageID: pageID, roomSeq: roomSeq}, wait)
}

func (w *Writer) IncrementPageAtSeq(roomID string, roomSeq uint64, wait bool) error {
	return w.enqueue(writeRequest{kind: "increment-page", roomID: roomID, totalPageDelta: 1, roomSeq: roomSeq}, wait)
}

func (w *Writer) Flush() error {
	return w.enqueue(writeRequest{kind: "flush"}, true)
}

func (w *Writer) IsDegraded() bool {
	return w.degraded.Load()
}

// SetAsyncFailureHandler registers the callback invoked when an unwaited write
// fails. It is called from the writer goroutine, so the handler must not block.
func (w *Writer) SetAsyncFailureHandler(handler func(roomID string, err error)) {
	w.asyncFailureMu.Lock()
	w.onAsyncFailure = handler
	w.asyncFailureMu.Unlock()
}

func (w *Writer) reportAsyncFailure(roomID string, err error) {
	w.asyncFailureMu.RLock()
	handler := w.onAsyncFailure
	w.asyncFailureMu.RUnlock()
	if handler != nil {
		handler(roomID, err)
	}
}

func (w *Writer) QueueLen() int {
	return len(w.writes)
}

func (w *Writer) QueueCap() int {
	return cap(w.writes)
}

// enqueueTimeout bounds how long a caller waits for queue space. The room actor
// is a single goroutine, so an unbounded wait here froze the whole room whenever
// the disk stalled, with no signal to anyone.
const enqueueTimeout = 5 * time.Second

var errWriterQueueFull = errors.New("database write queue is full")

func (w *Writer) enqueue(req writeRequest, wait bool) error {
	if wait {
		req.result = make(chan error, 1)
	}

	// Fast path: space available right now.
	select {
	case w.writes <- req:
	case <-w.closing:
		return errors.New("writer is closing")
	default:
		timer := time.NewTimer(enqueueTimeout)
		defer timer.Stop()
		select {
		case w.writes <- req:
		case <-w.closing:
			return errors.New("writer is closing")
		case <-timer.C:
			return errWriterQueueFull
		}
	}

	if req.result == nil {
		return nil
	}
	return <-req.result
}

func (w *Writer) loop() {
	defer close(w.done)
	ticker := time.NewTicker(w.cfg.DBBatchWindow)
	defer ticker.Stop()

	batch := make([]writeRequest, 0, w.cfg.DBBatchSize)

	// drainReady pulls any already-queued writes into the current batch. Barrier
	// writes must commit before their caller continues, but they do not have to
	// commit *alone*: folding in everything else that is already waiting turns
	// per-operation transactions into a group commit, which is what DB_BATCH_SIZE
	// was supposed to buy. Previously any waited write flushed immediately and
	// batching only ever applied to fire-and-forget updates.
	drainReady := func() {
		for len(batch) < w.cfg.DBBatchSize {
			select {
			case req := <-w.writes:
				batch = append(batch, req)
			default:
				return
			}
		}
	}

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
				continue
			}
			if results[index] != nil {
				// Nobody is waiting on this write, so surface the failure to the
				// owning room instead of losing it.
				slog.Error("asynchronous database write failed",
					"kind", req.kind, "room", req.roomID, "cmd", req.cmdID, "error", results[index])
				w.reportAsyncFailure(req.roomID, results[index])
			}
		}
		batch = batch[:0]
	}

	for {
		select {
		case req := <-w.writes:
			batch = append(batch, req)
			if req.result != nil {
				// A caller is blocked: commit now, but sweep in whatever else is
				// already queued so they share one transaction.
				drainReady()
				flush()
				continue
			}
			if len(batch) >= w.cfg.DBBatchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-w.closing:
			for {
				select {
				case req := <-w.writes:
					batch = append(batch, req)
					if len(batch) >= w.cfg.DBBatchSize {
						flush()
					}
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
