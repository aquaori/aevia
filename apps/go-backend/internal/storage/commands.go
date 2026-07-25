package storage

import (
	"context"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
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

func (s *Store) SaveCommand(roomID string, cmd domain.Command, wait bool) error {
	return s.writer.SaveCommand(roomID, cmd, wait)
}

func (s *Store) SaveCommandAtSeq(roomID string, cmd domain.Command, roomSeq uint64, wait bool) error {
	return s.writer.SaveCommandAtSeq(roomID, cmd, roomSeq, wait)
}

func (s *Store) DeleteCommand(roomID, cmdID string, wait bool) error {
	return s.writer.DeleteCommand(roomID, cmdID, wait)
}

func (s *Store) DeleteCommandAtSeq(roomID, cmdID string, roomSeq uint64, wait bool) error {
	return s.writer.DeleteCommandAtSeq(roomID, cmdID, roomSeq, wait)
}

func (s *Store) ClearCommands(roomID string, pageID *int, wait bool) error {
	return s.writer.ClearCommands(roomID, pageID, wait)
}

func (s *Store) ClearCommandsAtSeq(roomID string, pageID *int, roomSeq uint64, wait bool) error {
	return s.writer.ClearCommandsAtSeq(roomID, pageID, roomSeq, wait)
}

func (s *Store) IncrementPage(roomID string, wait bool) error {
	return s.writer.IncrementPage(roomID, wait)
}

func (s *Store) IncrementPageAtSeq(roomID string, roomSeq uint64, wait bool) error {
	return s.writer.IncrementPageAtSeq(roomID, roomSeq, wait)
}

func (s *Store) SaveReceipt(roomID, opID, userID string, roomSeq uint64, response string, wait bool) error {
	return s.writer.SaveReceipt(roomID, opID, userID, roomSeq, response, wait)
}

func (s *Store) IsDegraded() bool {
	return s.writer.IsDegraded()
}
