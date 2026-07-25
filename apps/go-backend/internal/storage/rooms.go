package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math/rand"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
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

func (s *Store) GenerateRoomID(ctx context.Context) (string, error) {
	for {
		id := fmt.Sprintf("%06d", 100000+rand.Intn(900000))
		exists, err := s.HasRoom(ctx, id)
		if err != nil || !exists {
			return id, err
		}
	}
}
