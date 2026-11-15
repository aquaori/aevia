package storage

import (
	"context"
	"time"
)

type Invite struct {
	ID        string `json:"id"`
	ExpiresAt int64  `json:"expiresAt"`
	CreatedAt int64  `json:"createdAt"`
}

func (s *Store) CreateInvite(ctx context.Context, id, roomID, userID string, expiresAt int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO room_invites(invite_id,room_id,creator_id,expires_at,created_at) VALUES(?,?,?,?,?)`, id, roomID, userID, expiresAt, time.Now().Unix())
	return err
}

func (s *Store) InviteValid(ctx context.Context, id, roomID string) bool {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM room_invites WHERE invite_id=? AND room_id=? AND revoked_at IS NULL AND expires_at>?`, id, roomID, time.Now().Unix()).Scan(&one)
	return err == nil
}

func (s *Store) Invites(ctx context.Context, roomID string) ([]Invite, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT invite_id,expires_at,created_at FROM room_invites WHERE room_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC`, roomID, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	invites := []Invite{}
	for rows.Next() {
		var invite Invite
		if err = rows.Scan(&invite.ID, &invite.ExpiresAt, &invite.CreatedAt); err != nil {
			return nil, err
		}
		invites = append(invites, invite)
	}
	return invites, rows.Err()
}

func (s *Store) RevokeInvite(ctx context.Context, roomID, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE room_invites SET revoked_at=? WHERE room_id=? AND invite_id=?`, time.Now().Unix(), roomID, id)
	return err
}
