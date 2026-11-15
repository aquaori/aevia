package storage

import (
	"context"
	"time"
)

func (s *Store) CreateWebsocketTicket(ctx context.Context, id string, expiresAt int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM websocket_tickets WHERE expires_at<=?`, time.Now().Unix())
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO websocket_tickets(ticket_hash,expires_at) VALUES(?,?)`, tokenHash(id), expiresAt)
	return err
}

func (s *Store) ConsumeWebsocketTicket(ctx context.Context, id string) (bool, error) {
	result, err := s.db.ExecContext(ctx, `DELETE FROM websocket_tickets WHERE ticket_hash=? AND expires_at>?`, tokenHash(id), time.Now().Unix())
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}
