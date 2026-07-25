package gateway

import "net/http"

func (s *Server) live(w http.ResponseWriter, _ *http.Request) {
	ok(w, map[string]any{"status": "live"})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		fail(w, http.StatusServiceUnavailable, "Server is draining")
		return
	}
	if err := s.store.Ready(r.Context()); err != nil {
		fail(w, http.StatusServiceUnavailable, "Database is not ready")
		return
	}
	ok(w, map[string]any{"status": "ready"})
}
