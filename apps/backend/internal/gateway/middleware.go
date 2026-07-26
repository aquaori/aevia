package gateway

import (
	"log/slog"
	"net/http"
)

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check the origin before answering anything, including preflight, so a
		// disallowed origin never receives a successful CORS handshake.
		if !s.originAllowed(r) {
			fail(w, http.StatusForbidden, "Origin is not allowed")
			return
		}
		origin := s.corsOrigin(r)
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			if origin != "*" {
				w.Header().Add("Vary", "Origin")
			}
		}
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Sec-WebSocket-Protocol")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func limitBody(next http.Handler, limit int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, limit)
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) limitHTTPRate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health/live" || r.URL.Path == "/health/ready" {
			next.ServeHTTP(w, r)
			return
		}
		ip := s.ipResolver.ClientIP(r)
		if !s.httpLimiter.Allow(ip) {
			fail(w, http.StatusTooManyRequests, "Too many requests")
			return
		}
		// Password guessing is throttled by charging only *failed* attempts (see
		// Server.notePasswordFailure). Charging every request instead would
		// throttle legitimate users too: a whole classroom behind one NAT shares
		// a single client IP, and rooms without a password would be limited for
		// no security benefit.
		if r.URL.Path == "/join-room" && s.authLimiter.Exhausted(ip) {
			slog.Warn("join rejected after repeated password failures", "ip", ip)
			fail(w, http.StatusTooManyRequests, "Too many failed attempts, please retry later")
			return
		}
		next.ServeHTTP(w, r)
	})
}
