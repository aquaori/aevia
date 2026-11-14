package storage

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

type RoomPolicy struct {
	DefaultRole     string `json:"defaultRole"`
	AllowRoomCode   bool   `json:"allowRoomCode"`
	GuestByCode     bool   `json:"guestByCode"`
	GuestByInvite   bool   `json:"guestByInvite"`
	PasswordVersion int    `json:"passwordVersion"`
}

type RoomMember struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	Nickname string `json:"nickname"`
	Role     string `json:"role"`
	Banned   bool   `json:"banned"`
}

func (s *Store) Policy(ctx context.Context, roomID string) (RoomPolicy, error) {
	policy := RoomPolicy{DefaultRole: "editor", AllowRoomCode: true, GuestByCode: true, GuestByInvite: true}
	err := s.db.QueryRowContext(ctx, `SELECT default_role,allow_room_code,guest_by_code,guest_by_invite,password_version FROM room_policies WHERE room_id=?`, roomID).Scan(&policy.DefaultRole, &policy.AllowRoomCode, &policy.GuestByCode, &policy.GuestByInvite, &policy.PasswordVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return policy, nil
	}
	return policy, err
}

func (s *Store) MemberRole(ctx context.Context, roomID, userID string) (string, bool, error) {
	var role string
	var banned sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT role,banned_at FROM room_members WHERE room_id=? AND user_id=?`, roomID, userID).Scan(&role, &banned)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return role, banned.Valid, err
}

func (s *Store) Members(ctx context.Context, roomID string) ([]RoomMember, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.user_id,COALESCE(u.username,''),COALESCE(p.nickname,u.username,''),m.role,m.banned_at IS NOT NULL FROM room_members m LEFT JOIN users u ON u.user_id=m.user_id LEFT JOIN user_profiles p ON p.user_id=m.user_id WHERE m.room_id=? ORDER BY m.created_at`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []RoomMember{}
	for rows.Next() {
		var m RoomMember
		if err = rows.Scan(&m.UserID, &m.Username, &m.Nickname, &m.Role, &m.Banned); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

func (s *Store) PasswordVerified(ctx context.Context, roomID, userID string, version int) bool {
	var stored int
	err := s.db.QueryRowContext(ctx, `SELECT version FROM room_password_verifications WHERE room_id=? AND user_id=?`, roomID, userID).Scan(&stored)
	return err == nil && stored == version
}

func (s *Store) MarkPasswordVerified(ctx context.Context, roomID, userID string, version int) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO room_password_verifications(room_id,user_id,version) VALUES(?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET version=excluded.version`, roomID, userID, version)
	return err
}

func (s *Store) UpdateRoomPolicy(ctx context.Context, roomID, name, password string, setPassword, requirePassword bool, p RoomPolicy) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `UPDATE rooms SET name=? WHERE room_id=?`, name, roomID); err != nil {
		return err
	}
	if setPassword {
		if _, err = tx.ExecContext(ctx, `UPDATE rooms SET password=? WHERE room_id=?`, password, roomID); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO room_policies(room_id,default_role,allow_room_code,guest_by_code,guest_by_invite,password_version) VALUES(?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET default_role=excluded.default_role,allow_room_code=excluded.allow_room_code,guest_by_code=excluded.guest_by_code,guest_by_invite=excluded.guest_by_invite,password_version=room_policies.password_version+?`, roomID, p.DefaultRole, p.AllowRoomCode, p.GuestByCode, p.GuestByInvite, 0, func() int {
		if setPassword && requirePassword {
			return 1
		}
		return 0
	}())
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) UpdateMember(ctx context.Context, roomID, userID, action string) error {
	switch action {
	case "editor", "viewer":
		_, err := s.db.ExecContext(ctx, `UPDATE room_members SET role=? WHERE room_id=? AND user_id=? AND role<>'owner'`, action, roomID, userID)
		return err
	case "kick", "leave":
		_, err := s.db.ExecContext(ctx, `DELETE FROM room_members WHERE room_id=? AND user_id=? AND role<>'owner'`, roomID, userID)
		return err
	case "ban":
		_, err := s.db.ExecContext(ctx, `UPDATE room_members SET banned_at=? WHERE room_id=? AND user_id=? AND role<>'owner'`, time.Now().Unix(), roomID, userID)
		return err
	case "unban":
		_, err := s.db.ExecContext(ctx, `DELETE FROM room_members WHERE room_id=? AND user_id=? AND banned_at IS NOT NULL`, roomID, userID)
		return err
	}
	return errors.New("invalid member action")
}

type AccountRoom struct {
	RoomID           string `json:"roomId"`
	Name             string `json:"name"`
	Role             string `json:"role"`
	PasswordRequired bool   `json:"passwordRequired"`
}

func (s *Store) CreateOwnedRoom(ctx context.Context, room domain.Room, ownerID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO rooms(room_id,name,password,created_at,total_page) VALUES(?,?,?,?,1)`, room.RoomID, room.Name, room.Password, room.CreatedAt); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO room_policies(room_id) VALUES(?)`, room.RoomID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO room_members(room_id,user_id,role,created_at) VALUES(?,?,?,?)`, room.RoomID, ownerID, "owner", time.Now().Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) AccountRooms(ctx context.Context, userID string) ([]AccountRoom, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT r.room_id,r.name,m.role,r.password<>'' FROM rooms r JOIN room_members m ON m.room_id=r.room_id WHERE m.user_id=? AND m.banned_at IS NULL ORDER BY r.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rooms := []AccountRoom{}
	for rows.Next() {
		var room AccountRoom
		if err = rows.Scan(&room.RoomID, &room.Name, &room.Role, &room.PasswordRequired); err != nil {
			return nil, err
		}
		rooms = append(rooms, room)
	}
	return rooms, rows.Err()
}

func (s *Store) JoinAccountRoom(ctx context.Context, roomID, userID string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO room_members(room_id,user_id,role,created_at) VALUES(?,?,COALESCE((SELECT default_role FROM room_policies WHERE room_id=?),'editor'),?) ON CONFLICT(room_id,user_id) DO NOTHING`, roomID, userID, roomID, time.Now().Unix())
	return err
}
