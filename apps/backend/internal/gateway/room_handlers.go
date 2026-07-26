package gateway

import (
	"log/slog"
	"net/http"
	"strings"

	"collaborative-whiteboard/apps/backend/internal/auth"
	"collaborative-whiteboard/apps/backend/internal/domain"
)

// notePasswordFailure charges one token against the caller's failure budget.
// Only wrong passwords count, so honest traffic never approaches the limit while
// guessing is cut off after a handful of tries.
func (s *Server) notePasswordFailure(r *http.Request) {
	s.authLimiter.Allow(s.ipResolver.ClientIP(r))
}

// isUniqueConstraintError reports whether err is a primary-key/unique collision,
// which for room creation means the room already exists.
func isUniqueConstraintError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique constraint") || strings.Contains(message, "constraint failed")
}

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
	// Distinguish a duplicate room from an actual storage failure. Both used to
	// return 400 "Room already exists", so a full disk or corrupt schema was
	// reported to users as a name collision.
	exists, err := s.store.HasRoom(r.Context(), req.RoomID)
	if err != nil {
		slog.Error("room existence check failed", "room", req.RoomID, "error", err)
		fail(w, http.StatusInternalServerError, "Room lookup failed")
		return
	}
	if exists {
		fail(w, http.StatusBadRequest, "Room already exists")
		return
	}
	err = s.store.CreateRoom(r.Context(), domain.Room{
		RoomID: req.RoomID, Name: req.RoomName, Password: password, CreatedAt: domain.NowMillis(), TotalPage: 1,
	})
	if err != nil {
		if isUniqueConstraintError(err) {
			fail(w, http.StatusBadRequest, "Room already exists")
			return
		}
		slog.Error("room creation failed", "room", req.RoomID, "error", err)
		fail(w, http.StatusInternalServerError, "Room creation failed")
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
		s.notePasswordFailure(r)
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
