package gateway

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"collaborative-whiteboard/apps/backend/internal/auth"
	"collaborative-whiteboard/apps/backend/internal/domain"
	"collaborative-whiteboard/apps/backend/internal/storage"
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
	RoomID      string `json:"roomId"`
	UserName    string `json:"userName"`
	Password    string `json:"password"`
	InviteToken string `json:"inviteToken"`
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
	account, accountErr := s.accountFromRequest(r)
	if accountErr == nil {
		req.UserName = account.Nickname
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
	policy, err := s.store.Policy(r.Context(), req.RoomID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Room lookup failed")
		return
	}
	role := ""
	if accountErr == nil {
		var banned bool
		role, banned, err = s.store.MemberRole(r.Context(), req.RoomID, account.ID)
		if err != nil {
			fail(w, 500, "Room lookup failed")
			return
		}
		if banned {
			fail(w, 403, "您已被房主禁止加入此房间")
			return
		}
	}
	invited := false
	if req.InviteToken != "" {
		invite, verifyErr := s.tokens.Verify(req.InviteToken, "invite")
		if verifyErr != nil || invite.RoomID != req.RoomID || invite.RoomCreatedAt != roomData.CreatedAt || !s.store.InviteValid(r.Context(), invite.InviteID, req.RoomID) {
			fail(w, 403, "邀请链接无效或已过期")
			return
		}
		invited = true
	}
	if role == "" {
		if !invited && !policy.AllowRoomCode {
			fail(w, 403, "房间已关闭房间号加入")
			return
		}
		if accountErr != nil && ((!invited && !policy.GuestByCode) || (invited && !policy.GuestByInvite)) {
			fail(w, 403, "房间不允许游客通过此方式加入")
			return
		}
	}
	passwordVerified := accountErr == nil && role != "" && s.store.PasswordVerified(r.Context(), req.RoomID, account.ID, policy.PasswordVersion)
	if !passwordVerified && !auth.VerifyPassword(req.Password, roomData.Password) {
		s.notePasswordFailure(r)
		fail(w, http.StatusBadRequest, "Password incorrect")
		return
	}
	userID := randomID()
	if accountErr == nil {
		if err := s.store.JoinAccountRoom(r.Context(), req.RoomID, account.ID); err != nil {
			fail(w, http.StatusInternalServerError, "Unable to join room")
			return
		}
		userID = account.ID
		if err := s.store.MarkPasswordVerified(r.Context(), req.RoomID, account.ID, policy.PasswordVersion); err != nil {
			fail(w, 500, "Unable to join room")
			return
		}
		if role == "" {
			role = policy.DefaultRole
		}
	}
	if role == "" {
		role = policy.DefaultRole
	}
	token, expiresAt, err := s.tokens.Sign(auth.Claims{
		UserID: userID, UserName: req.UserName, RoomID: roomData.RoomID,
		RoomName: roomData.Name, RoomCreatedAt: roomData.CreatedAt, TokenType: "session", Account: accountErr == nil, Role: role,
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
	if !s.canShareRoom(w, r, claims) {
		return
	}
	roomID := claims.RoomID
	if requested := r.URL.Query().Get("roomId"); requested != "" && requested != roomID {
		fail(w, 403, "Token room does not match request room")
		return
	}
	roomData, exists, err := s.store.GetRoom(r.Context(), roomID)
	if err != nil || !exists {
		fail(w, 400, "Room does not exist")
		return
	}
	ttl := s.cfg.InviteTTL
	if hours, err := strconv.Atoi(r.URL.Query().Get("hours")); err == nil && hours > 0 && hours <= 24*30 {
		ttl = time.Duration(hours) * time.Hour
	}
	id, err := storage.RandomID()
	if err != nil {
		fail(w, 500, "无法创建邀请")
		return
	}
	token, expiresAt, err := s.tokens.Sign(auth.Claims{
		RoomID: roomData.RoomID, RoomName: roomData.Name, RoomCreatedAt: roomData.CreatedAt,
		PasswordRequired: roomData.Password != "", TokenType: "invite", InviteID: id,
	}, ttl)
	if err != nil || s.store.CreateInvite(r.Context(), id, roomID, claims.UserID, expiresAt/1000) != nil {
		fail(w, 500, "无法创建邀请")
		return
	}
	ok(w, map[string]any{"inviteToken": token, "token": token, "passwordRequired": roomData.Password != "", "expiresAt": expiresAt})
}

func (s *Server) canShareRoom(w http.ResponseWriter, r *http.Request, claims auth.Claims) bool {
	role := claims.Role
	if claims.Account {
		var banned bool
		var err error
		role, banned, err = s.store.MemberRole(r.Context(), claims.RoomID, claims.UserID)
		if err != nil || banned {
			fail(w, 403, "没有邀请权限")
			return false
		}
	}
	if role == "viewer" || (claims.Account && role == "") {
		fail(w, 403, "没有邀请权限")
		return false
	}
	return true
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
	if !s.store.InviteValid(r.Context(), claims.InviteID, claims.RoomID) {
		fail(w, http.StatusBadRequest, "Invalid invite token")
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
		RoomName: roomData.Name, RoomCreatedAt: roomData.CreatedAt, TokenType: "session", Account: claims.Account, Role: claims.Role,
	}, s.cfg.SessionTTL)
	if err != nil {
		fail(w, http.StatusInternalServerError, "Token generation failed")
		return
	}
	ok(w, map[string]any{"sessionToken": token, "token": token, "expiresAt": expiresAt})
}
