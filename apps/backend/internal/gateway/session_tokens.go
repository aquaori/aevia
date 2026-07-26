package gateway

import (
	"errors"
	"log/slog"
	"time"

	"collaborative-whiteboard/apps/backend/internal/auth"
)

var errStaleSessionToken = errors.New("session token predates the session epoch")

// verifySessionToken validates a room session token and rejects anything issued
// before the persisted session epoch.
//
// The epoch used to be this process's start time, which logged every user out on
// each deploy and made horizontal scaling impossible (each replica had its own
// cutoff). It now comes from storage.Store.SessionEpoch, so it is stable across
// restarts and shared between replicas pointed at the same database.
func (s *Server) verifySessionToken(token string) (auth.Claims, error) {
	claims, err := s.tokens.Verify(token, "session")
	if err != nil {
		return auth.Claims{}, err
	}

	if claims.Iat < s.sessionEpoch {
		slog.Warn(
			"stale session token rejected",
			"room", claims.RoomID,
			"userId", claims.UserID,
			"issuedAt", time.Unix(claims.Iat, 0),
			"sessionEpoch", time.Unix(s.sessionEpoch, 0),
		)
		return auth.Claims{}, errStaleSessionToken
	}

	return claims, nil
}
