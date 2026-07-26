package storage

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"math/big"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func (s *Store) EnsureDefaultRoom(ctx context.Context, roomID string) error {
	exists, err := s.HasRoom(ctx, roomID)
	if err != nil || exists {
		return err
	}
	return s.CreateRoom(ctx, domain.Room{RoomID: roomID, Name: roomID, CreatedAt: domain.NowMillis(), TotalPage: 1})
}

func (s *Store) CreateRoom(ctx context.Context, room domain.Room) error {
	if room.Name == "" {
		room.Name = "房间" + room.RoomID
	}
	if room.CreatedAt == 0 {
		room.CreatedAt = domain.NowMillis()
	}
	if room.TotalPage <= 0 {
		room.TotalPage = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO rooms(room_id,name,password,created_at,total_page) VALUES(?,?,?,?,?)`,
		room.RoomID, room.Name, room.Password, room.CreatedAt, room.TotalPage)
	return err
}

func (s *Store) HasRoom(ctx context.Context, roomID string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM rooms WHERE room_id=? LIMIT 1`, roomID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) GetRoom(ctx context.Context, roomID string) (domain.Room, bool, error) {
	var room domain.Room
	err := s.db.QueryRowContext(ctx, `SELECT room_id,name,password,created_at,total_page,durable_seq FROM rooms WHERE room_id=?`, roomID).
		Scan(&room.RoomID, &room.Name, &room.Password, &room.CreatedAt, &room.TotalPage, &room.DurableSeq)
	if errors.Is(err, sql.ErrNoRows) {
		return room, false, nil
	}
	return room, err == nil, err
}

func (s *Store) UpdateRoomPassword(ctx context.Context, roomID, password string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE rooms SET password=? WHERE room_id=?`, password, roomID)
	return err
}

// GenerateRoomID returns an unused six-digit room ID.
//
// The source is crypto/rand rather than math/rand: room IDs are the only thing
// standing between an outsider and an unprotected room, and math/rand is
// predictable from a known seed. The attempt count is bounded so a saturated or
// failing table cannot spin forever.
func (s *Store) GenerateRoomID(ctx context.Context) (string, error) {
	const maxAttempts = 32
	for attempt := 0; attempt < maxAttempts; attempt++ {
		n, err := rand.Int(rand.Reader, big.NewInt(900000))
		if err != nil {
			return "", err
		}
		id := fmt.Sprintf("%06d", 100000+n.Int64())
		exists, err := s.HasRoom(ctx, id)
		if err != nil {
			return "", err
		}
		if !exists {
			return id, nil
		}
	}
	return "", errors.New("could not allocate an unused room id")
}
