package gateway

import "net/http"

func (s *Server) metrics(w http.ResponseWriter, _ *http.Request) {
	ok(w, map[string]any{
		"status": map[string]any{
			"draining": s.draining.Load(),
			"started":  s.started.UnixMilli(),
		},
		"connections": s.connectionLimit.Snapshot(),
		"storage":     s.store.Metrics(),
		"rooms":       s.registry.Stats(),
	})
}
