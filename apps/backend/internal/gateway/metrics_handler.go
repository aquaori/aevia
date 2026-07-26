package gateway

import (
	"crypto/subtle"
	"net/http"
	"os"
)

// metrics exposes room, connection and storage internals. It is gated behind
// METRICS_TOKEN because the payload enumerates live room IDs and per-room
// activity. With no token configured it is only served to loopback callers, so a
// default deployment does not publish it.
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	if !s.metricsAuthorized(r) {
		fail(w, http.StatusNotFound, "Not found")
		return
	}
	ok(w, map[string]any{
		"status": map[string]any{
			"draining": s.draining.Load(),
			"started":  s.started.UnixMilli(),
			"epoch":    s.sessionEpoch,
		},
		"connections": s.connectionLimit.Snapshot(),
		"limiters": map[string]any{
			"httpKeys": s.httpLimiter.Size(),
			"authKeys": s.authLimiter.Size(),
		},
		"storage": s.store.Metrics(),
		"rooms":   s.registry.Stats(),
	})
}

func (s *Server) metricsAuthorized(r *http.Request) bool {
	expected := os.Getenv("METRICS_TOKEN")
	if expected == "" {
		return isLoopback(peerIP(r))
	}
	provided := bearerToken(r)
	if provided == "" {
		provided = r.URL.Query().Get("token")
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}
