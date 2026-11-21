package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"collaborative-whiteboard/apps/backend/internal/auth"
)

type contextKey string

const claimsKey contextKey = "claims"

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func ok(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusOK, map[string]any{"code": 200, "msg": "success", "data": data})
}

func okNoData(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]any{"code": 200, "msg": "success"})
}

func fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"code": status, "msg": msg})
}

func decodeJSON(r *http.Request, target any) error {
	return json.NewDecoder(r.Body).Decode(target)
}

func bearerToken(r *http.Request) string {
	value := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(value), "bearer ") {
		return strings.TrimSpace(value[7:])
	}
	return ""
}

func (s *Server) withSession(next func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			fail(w, http.StatusUnauthorized, "Token required")
			return
		}
		claims, err := s.verifySessionToken(token)
		if err != nil {
			fail(w, http.StatusUnauthorized, "Invalid token")
			return
		}
		roomData, exists, err := s.store.GetRoom(r.Context(), claims.RoomID)
		if err != nil {
			fail(w, http.StatusInternalServerError, "无法读取房间信息")
			return
		}
		if !exists || roomData.CreatedAt != claims.RoomCreatedAt {
			fail(w, http.StatusUnauthorized, "房间会话已失效")
			return
		}
		if claims.Account {
			role, banned, err := s.store.MemberRole(r.Context(), claims.RoomID, claims.UserID)
			if err != nil {
				fail(w, http.StatusInternalServerError, "无法读取成员信息")
				return
			}
			if banned || role == "" {
				fail(w, http.StatusForbidden, "房间访问权限已失效")
				return
			}
		} else {
			_, kicked, err := s.store.GuestRole(r.Context(), claims.RoomID, claims.UserID)
			if err != nil || kicked {
				fail(w, http.StatusForbidden, "房间访问权限已失效")
				return
			}
		}
		next(w, r.WithContext(context.WithValue(r.Context(), claimsKey, claims)))
	}
}

func claimsFrom(r *http.Request) (claims auth.Claims, ok bool) {
	claims, ok = r.Context().Value(claimsKey).(auth.Claims)
	return claims, ok
}
