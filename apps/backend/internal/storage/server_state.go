package storage

import (
	"context"
	"database/sql"
	"errors"
	"strconv"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

const sessionEpochKey = "session_epoch"

// SessionEpoch returns the unix-second boundary before which room session tokens
// are rejected as stale.
//
// This used to be the process start time, which meant every restart invalidated
// every live session and two instances behind one load balancer rejected each
// other's tokens. The value is now persisted, so it survives restarts and is
// shared by every instance pointed at the same database. It is only advanced
// deliberately, via BumpSessionEpoch, which is the supported way to force a
// global re-authentication.
func (s *Store) SessionEpoch(ctx context.Context) (int64, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM server_state WHERE key=?`, sessionEpochKey).Scan(&raw)
	if err == nil {
		epoch, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr == nil {
			return epoch, nil
		}
		// A corrupt value should not lock every client out; re-seed it.
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}

	epoch := domain.NowMillis() / 1000
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO server_state(key,value,updated_at) VALUES(?,?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		sessionEpochKey, strconv.FormatInt(epoch, 10), domain.NowMillis()); err != nil {
		return 0, err
	}
	return epoch, nil
}

// BumpSessionEpoch moves the epoch to now, invalidating every issued session
// token across all instances. Intended for credential rotation or incident
// response, not for routine restarts.
func (s *Store) BumpSessionEpoch(ctx context.Context) (int64, error) {
	epoch := domain.NowMillis() / 1000
	_, err := s.db.ExecContext(ctx, `
INSERT INTO server_state(key,value,updated_at) VALUES(?,?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		sessionEpochKey, strconv.FormatInt(epoch, 10), domain.NowMillis())
	if err != nil {
		return 0, err
	}
	return epoch, nil
}
