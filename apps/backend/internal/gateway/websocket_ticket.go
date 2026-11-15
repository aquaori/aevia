package gateway

import (
	"net/http"
	"time"

	"collaborative-whiteboard/apps/backend/internal/storage"
)

func (s *Server) issueWebsocketTicket(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r)
	if claims.RoomID != r.PathValue("roomId") {
		fail(w, 403, "房间不匹配")
		return
	}
	room, exists, err := s.store.GetRoom(r.Context(), claims.RoomID)
	if err != nil || !exists || room.CreatedAt != claims.RoomCreatedAt {
		fail(w, 401, "房间会话已失效")
		return
	}
	if claims.Account {
		role, banned, err := s.store.MemberRole(r.Context(), claims.RoomID, claims.UserID)
		if err != nil || banned || role == "" {
			fail(w, 403, "房间访问权限已失效")
			return
		}
	} else if claims.Role != "" {
		_, kicked, err := s.store.GuestRole(r.Context(), claims.RoomID, claims.UserID)
		if err != nil || kicked {
			fail(w, 403, "房间访问权限已失效")
			return
		}
	}
	id, err := storage.RandomID()
	if err != nil {
		fail(w, 500, "无法创建连接票据")
		return
	}
	claims.TokenType = "ws-ticket"
	claims.TicketID = id
	token, expiresAt, err := s.tokens.Sign(claims, 30*time.Second)
	if err != nil || s.store.CreateWebsocketTicket(r.Context(), id, expiresAt/1000) != nil {
		fail(w, 500, "无法创建连接票据")
		return
	}
	ok(w, map[string]any{"ticket": token, "expiresAt": expiresAt})
}
