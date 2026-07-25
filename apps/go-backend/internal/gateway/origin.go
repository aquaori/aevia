package gateway

import (
	"net/http"
	"strings"
)

func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	for _, allowed := range s.cfg.AllowedOrigins {
		if allowed == "*" || strings.EqualFold(allowed, origin) {
			return true
		}
	}
	return false
}

func (s *Server) wsOriginPatterns() []string {
	for _, allowed := range s.cfg.AllowedOrigins {
		if allowed == "*" {
			return []string{"*"}
		}
	}
	return s.cfg.AllowedOrigins
}

func (s *Server) corsOrigin(r *http.Request) string {
	for _, allowed := range s.cfg.AllowedOrigins {
		if allowed == "*" {
			return "*"
		}
	}
	origin := r.Header.Get("Origin")
	if origin != "" && s.originAllowed(r) {
		return origin
	}
	return ""
}
