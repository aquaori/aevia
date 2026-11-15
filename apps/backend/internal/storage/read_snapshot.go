package storage

import (
	"context"
	"database/sql"
	"time"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

// ReadSnapshot pins a WAL read view before the room actor processes later writes.
type ReadSnapshot struct {
	tx     *sql.Tx
	conn   *sql.Conn
	roomID string
}

func (s *Store) BeginReadSnapshot(ctx context.Context, roomID string) (*ReadSnapshot, uint64, error) {
	acquireCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	conn, err := s.db.Conn(acquireCtx)
	cancel()
	if err != nil {
		return nil, 0, err
	}
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		conn.Close()
		return nil, 0, err
	}
	var seq uint64
	queryCtx, queryCancel := context.WithTimeout(ctx, 250*time.Millisecond)
	err = tx.QueryRowContext(queryCtx, `SELECT durable_seq FROM rooms WHERE room_id=?`, roomID).Scan(&seq)
	queryCancel()
	if err != nil {
		tx.Rollback()
		conn.Close()
		return nil, 0, err
	}
	return &ReadSnapshot{tx: tx, conn: conn, roomID: roomID}, seq, nil
}

func (s *ReadSnapshot) Close() { _ = s.tx.Rollback(); _ = s.conn.Close() }

func (s *ReadSnapshot) Commands(ctx context.Context) ([]domain.Command, error) {
	rows, err := s.tx.QueryContext(ctx, `SELECT payload FROM commands WHERE room_id=? ORDER BY id ASC`, s.roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var commands []domain.Command
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		command, err := domain.CommandFromPayload([]byte(payload))
		if err != nil {
			return nil, err
		}
		commands = append(commands, command)
	}
	return commands, rows.Err()
}
