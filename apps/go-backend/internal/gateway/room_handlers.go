package gateway

import (
	"database/sql"
	"errors"
	"log/slog"
	"net/http"

	"collaborative-whiteboard/apps/go-backend/internal/auth"
	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

type createRoomRequest struct {
	RoomID   string `json:"roomId"`
	RoomName string `json:"roomName"`
	Password string `json:"password"`
}

type joinRoomRequest struct {
	RoomID   string `json:"roomId"`
	UserName string `json:"userName"`
	Password string `json:"password"`
}

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	var req createRoomRequest
	if decodeJSON(r, &req) != nil || req.RoomID == "" {
		fail(w, http.StatusBadRequest, "Room ID is required")
		return
	}
	password, err := auth.HashPassword(req.Password)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Password hashing failed")
		return
	}
	err = s.store.CreateRoom(r.Context(), domain.Room{
		RoomID: req.RoomID, Name: req.RoomName, Password: password, CreatedAt: domain.NowMillis(), TotalPage: 1,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, http.StatusBadRequest, "Room already exists")
			return
		}
		fail(w, http.StatusBadRequest, "Room already exists")
		return
	}
	slog.Info("room created", "room", req.RoomID, "name", req.RoomName, "password", req.Password != "")
	okNoData(w)
}

func (s *Server) checkRoom(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("roomId")
	if roomID == "" {
		fail(w, http.StatusBadRequest, "Room ID is required")
		return
	}
	exists, err := s.store.HasRoom(r.Context(), roomID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Room lookup failed")
		return
	}
	ok(w, map[string]any{"status": exists})
}

func (s *Server) generateRoomID(w http.ResponseWriter, r *http.Request) {
	roomID, err := s.store.GenerateRoomID(r.Context())
	if err != nil {
		fail(w, http.StatusInternalServerError, "Room ID generation failed")
		return
	}
	ok(w, map[string]any{"roomId": roomID})
}

func (s *Server) joinRoom(w http.ResponseWriter, r *http.Request) {
	var req joinRoomRequest
	if decodeJSON(r, &req) != nil || req.RoomID == "" {
		fail(w, http.StatusBadRequest, "Room ID is required")
		return
	}
	if req.UserName == "" {
		fail(w, http.StatusBadRequest, "User Name is required")
		return
	}
	roomData, exists, err := s.store.GetRoom(r.Context(), req.RoomID)
	if err != nil || !exists {
		fail(w, http.StatusBadRequest, "Room does not exist")
		return
	}
	if !auth.VerifyPassword(req.Password, roomData.Password) {
		fail(w, http.StatusBadRequest, "Password incorrect")
		return
	}
	userID := randomID()
	token, expiresAt, err := s.tokens.Sign(auth.Claims{
		UserID: userID, UserName: req.UserName, RoomID: roomData.RoomID,
		RoomName: roomData.Name, RoomCreatedAt: roomData.CreatedAt, TokenType: "session",
	}, s.cfg.SessionTTL)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Token generation failed")
		return
	}
	slog.Info("room joined", "room", roomData.RoomID, "user", req.UserName, "userId", userID)
	ok(w, map[string]any{"sessionToken": token, "token": token, "expiresAt": expiresAt})
}

func (s *Server) generateShareToken(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r)
	roomID := claims.RoomID
	if requested := r.URL.Query().Get("roomId"); requested != "" && requested != roomID {
		fail(w, http.StatusForbidden, "Token room does not match request room")
		return
	}
	roomData, exists, err := s.store.GetRoom(r.Context(), roomID)
	if err != nil || !exists {
		fail(w, http.StatusBadRequest, "Room does not exist")
		return
	}
	token, _, err := s.tokens.Sign(auth.Claims{
		RoomID: roomData.RoomID, RoomName: roomData.Name, RoomCreatedAt: roomData.CreatedAt,
		PasswordRequired: roomData.Password != "", TokenType: "invite",
	}, s.cfg.InviteTTL)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Token generation failed")
		return
	}
	ok(w, map[string]any{"inviteToken": token, "token": token, "passwordRequired": roomData.Password != ""})
}

func (s *Server) getTokenInfo(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		fail(w, http.StatusBadRequest, "Token required")
		return
	}
	claims, err := s.tokens.Verify(token, "invite")
	if err != nil {
		fail(w, http.StatusBadRequest, "Invalid invite token")
		return
	}
	roomData, exists, err := s.store.GetRoom(r.Context(), claims.RoomID)
	if err != nil || !exists || claims.RoomCreatedAt != roomData.CreatedAt {
		fail(w, http.StatusBadRequest, "Room does not exist")
		return
	}
	ok(w, map[string]any{"roomId": roomData.RoomID, "roomName": roomData.Name, "roomCreatedAt": roomData.CreatedAt, "passwordRequired": roomData.Password != ""})
}

func (s *Server) renewSession(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r)
	roomData, exists, err := s.store.GetRoom(r.Context(), claims.RoomID)
	if err != nil || !exists || claims.RoomCreatedAt != roomData.CreatedAt {
		fail(w, http.StatusUnauthorized, "Room session is no longer valid")
		return
	}
	token, expiresAt, err := s.tokens.Sign(auth.Claims{
		UserID: claims.UserID, UserName: claims.UserName, RoomID: roomData.RoomID,
		RoomName: roomData.Name, RoomCreatedAt: roomData.CreatedAt, TokenType: "session",
	}, s.cfg.SessionTTL)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Token generation failed")
		return
	}
	ok(w, map[string]any{"sessionToken": token, "token": token, "expiresAt": expiresAt})
}
