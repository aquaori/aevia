package storage

import (
	"context"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func (s *Store) ListCommands(ctx context.Context, roomID string) ([]domain.Command, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT payload FROM commands WHERE room_id=? ORDER BY id ASC`, roomID)
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
		cmd, err := domain.CommandFromPayload([]byte(payload))
		if err != nil {
			return nil, err
		}
		commands = append(commands, cmd)
	}
	return commands, rows.Err()
}

// The *AtSeq writes stamp rooms.durable_seq alongside the mutation so a restart
// knows how far the persisted log advanced. wait=true commits before returning;
// wait=false batches and reports failures through the async failure handler.

func (s *Store) SaveCommandAtSeq(roomID string, cmd domain.Command, roomSeq uint64, wait bool) error {
	return s.writer.SaveCommandAtSeq(roomID, cmd, roomSeq, wait)
}

func (s *Store) DeleteCommandAtSeq(roomID, cmdID string, roomSeq uint64, wait bool) error {
	return s.writer.DeleteCommandAtSeq(roomID, cmdID, roomSeq, wait)
}

func (s *Store) ClearCommandsAtSeq(roomID string, pageID *int, roomSeq uint64, wait bool) error {
	return s.writer.ClearCommandsAtSeq(roomID, pageID, roomSeq, wait)
}

func (s *Store) IncrementPageAtSeq(roomID string, roomSeq uint64, wait bool) error {
	return s.writer.IncrementPageAtSeq(roomID, roomSeq, wait)
}

func (s *Store) IsDegraded() bool {
	return s.writer.IsDegraded()
}

// SetAsyncFailureHandler routes fire-and-forget write failures to the caller so
// the owning room can degrade instead of silently serving non-durable state.
func (s *Store) SetAsyncFailureHandler(handler func(roomID string, err error)) {
	if s.writer != nil {
		s.writer.SetAsyncFailureHandler(handler)
	}
}
