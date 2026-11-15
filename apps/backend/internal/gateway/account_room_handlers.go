package gateway

import (
	"net/http"
	"strings"

	"collaborative-whiteboard/apps/backend/internal/auth"
	"collaborative-whiteboard/apps/backend/internal/domain"
)

func (s *Server) createAccountRoom(w http.ResponseWriter, r *http.Request) {
	account, err := s.accountFromRequest(r)
	if err != nil {
		fail(w, http.StatusUnauthorized, "请先登录")
		return
	}
	var req createRoomRequest
	if decodeJSON(r, &req) != nil || req.RoomID == "" {
		fail(w, 400, "Room ID is required")
		return
	}
	if strings.TrimSpace(req.RoomName) == "" {
		req.RoomName = "房间" + req.RoomID
	}
	password, err := auth.HashPassword(req.Password)
	if err != nil {
		fail(w, 500, "创建房间失败")
		return
	}
	err = s.store.CreateOwnedRoom(r.Context(), domain.Room{RoomID: req.RoomID, Name: strings.TrimSpace(req.RoomName), Password: password, CreatedAt: domain.NowMillis()}, account.ID)
	if err != nil {
		if isUniqueConstraintError(err) {
			fail(w, 400, "Room already exists")
		} else {
			fail(w, 500, "创建房间失败")
		}
		return
	}
	if err := s.store.MarkPasswordVerified(r.Context(), req.RoomID, account.ID, 0); err != nil {
		fail(w, 500, "创建房间失败")
		return
	}
	ok(w, map[string]any{"roomId": req.RoomID})
}

func (s *Server) listAccountRooms(w http.ResponseWriter, r *http.Request) {
	account, err := s.accountFromRequest(r)
	if err != nil {
		fail(w, 401, "请先登录")
		return
	}
	rooms, err := s.store.AccountRooms(r.Context(), account.ID)
	if err != nil {
		fail(w, 500, "无法获取房间列表")
		return
	}
	ok(w, rooms)
}
