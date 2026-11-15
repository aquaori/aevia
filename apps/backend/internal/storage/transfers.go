package storage

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

type RoomTransfer struct {
	RoomID        string `json:"roomId"`
	RoomName      string `json:"roomName"`
	OwnerNickname string `json:"ownerNickname"`
}

func (s *Store) TransferOwner(ctx context.Context, roomID, targetID string) (string, error) {
	var owner string
	err := s.db.QueryRowContext(ctx, `SELECT owner_id FROM room_transfers WHERE room_id=? AND target_id=?`, roomID, targetID).Scan(&owner)
	return owner, err
}

func (s *Store) RequestTransfer(ctx context.Context, roomID, ownerID, targetID string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO room_transfers(room_id,owner_id,target_id,created_at) VALUES(?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET owner_id=excluded.owner_id,target_id=excluded.target_id,created_at=excluded.created_at`, roomID, ownerID, targetID, time.Now().Unix())
	return err
}

func (s *Store) PendingTransfers(ctx context.Context, targetID string) ([]RoomTransfer, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT t.room_id,r.name,COALESCE(p.nickname,u.username) FROM room_transfers t JOIN rooms r ON r.room_id=t.room_id JOIN users u ON u.user_id=t.owner_id LEFT JOIN user_profiles p ON p.user_id=u.user_id WHERE t.target_id=?`, targetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []RoomTransfer{}
	for rows.Next() {
		var item RoomTransfer
		if err = rows.Scan(&item.RoomID, &item.RoomName, &item.OwnerNickname); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) RespondTransfer(ctx context.Context, roomID, targetID string, accept bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var owner string
	if err = tx.QueryRowContext(ctx, `SELECT owner_id FROM room_transfers WHERE room_id=? AND target_id=?`, roomID, targetID).Scan(&owner); err != nil {
		return err
	}
	if accept {
		var role string
		var banned sql.NullInt64
		if err = tx.QueryRowContext(ctx, `SELECT role,banned_at FROM room_members WHERE room_id=? AND user_id=?`, roomID, targetID).Scan(&role, &banned); err != nil || banned.Valid {
			return errors.New("target is no longer a member")
		}
		result, updateErr := tx.ExecContext(ctx, `UPDATE room_members SET role=COALESCE((SELECT default_role FROM room_policies WHERE room_id=?),'editor') WHERE room_id=? AND user_id=? AND role='owner'`, roomID, roomID, owner)
		if updateErr != nil {
			return updateErr
		}
		changed, _ := result.RowsAffected()
		if changed != 1 {
			return errors.New("owner changed")
		}
		if _, err = tx.ExecContext(ctx, `UPDATE room_members SET role='owner' WHERE room_id=? AND user_id=?`, roomID, targetID); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM room_transfers WHERE room_id=?`, roomID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeleteRoom(ctx context.Context, roomID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range []string{"commands", "room_members", "room_role_capabilities", "room_password_verifications", "room_invites", "room_transfers", "room_policies", "guest_sessions", "room_member_audit"} {
		if _, err = tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE room_id=?`, roomID); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM rooms WHERE room_id=?`, roomID); err != nil {
		return err
	}
	return tx.Commit()
}
