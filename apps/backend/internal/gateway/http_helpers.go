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
		next(w, r.WithContext(context.WithValue(r.Context(), claimsKey, claims)))
	}
}

func claimsFrom(r *http.Request) (claims auth.Claims, ok bool) {
	claims, ok = r.Context().Value(claimsKey).(auth.Claims)
	return claims, ok
}
