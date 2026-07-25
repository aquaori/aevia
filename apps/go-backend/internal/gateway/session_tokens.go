package gateway

import (
	"errors"
	"log/slog"
	"time"

	"collaborative-whiteboard/apps/go-backend/internal/auth"
)

var errStaleSessionToken = errors.New("session token predates server start")

func (s *Server) verifySessionToken(token string) (auth.Claims, error) {
	claims, err := s.tokens.Verify(token, "session")
	if err != nil {
		return auth.Claims{}, err
	}

	issuedAt := time.Unix(claims.Iat, 0)
	if issuedAt.Before(s.started.Truncate(time.Second)) {
		slog.Warn(
			"stale session token rejected",
			"room", claims.RoomID,
			"userId", claims.UserID,
			"issuedAt", issuedAt,
			"serverStartedAt", s.started,
		)
		return auth.Claims{}, errStaleSessionToken
	}

	return claims, nil
}
