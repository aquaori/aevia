package storage

import (
	"context"
	"database/sql"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

func applyWrite(ctx context.Context, tx *sql.Tx, req writeRequest) error {
	now := domain.NowMillis()
	switch req.kind {
	case "save":
		return saveCommand(ctx, tx, req, now)
	case "delete":
		_, err := tx.ExecContext(ctx, `DELETE FROM commands WHERE room_id=? AND cmd_id=?`, req.roomID, req.cmdID)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE rooms SET durable_seq=max(durable_seq, ?) WHERE room_id=?`, req.roomSeq, req.roomID)
		return err
	case "clear":
		if req.pageID != nil {
			_, err := tx.ExecContext(ctx, `DELETE FROM commands WHERE room_id=? AND page_id=?`, req.roomID, *req.pageID)
			if err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `UPDATE rooms SET durable_seq=max(durable_seq, ?) WHERE room_id=?`, req.roomSeq, req.roomID)
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM commands WHERE room_id=?`, req.roomID)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE rooms SET durable_seq=max(durable_seq, ?) WHERE room_id=?`, req.roomSeq, req.roomID)
		return err
	case "increment-page":
		_, err := tx.ExecContext(ctx, `UPDATE rooms SET total_page=total_page+?, durable_seq=max(durable_seq, ?) WHERE room_id=?`, req.totalPageDelta, req.roomSeq, req.roomID)
		return err
	default:
		return nil
	}
}

func saveCommand(ctx context.Context, tx *sql.Tx, req writeRequest, now int64) error {
	payload, err := req.cmd.Payload()
	if err != nil {
		return err
	}
	pageID, ok := req.cmd.PageID()
	var page any
	if ok {
		page = pageID
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO commands(room_id,cmd_id,page_id,type,payload,is_deleted,room_seq,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?)
ON CONFLICT(room_id, cmd_id) DO UPDATE SET
  page_id=excluded.page_id,
  type=excluded.type,
  payload=excluded.payload,
  is_deleted=excluded.is_deleted,
  revision=commands.revision+1,
  room_seq=excluded.room_seq,
  updated_at=excluded.updated_at`,
		req.roomID, req.cmd.ID(), page, req.cmd.Type(), string(payload), boolInt(req.cmd.IsDeleted()), req.roomSeq, now, now)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE rooms SET durable_seq=max(durable_seq, ?) WHERE room_id=?`, req.roomSeq, req.roomID)
	return err
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
