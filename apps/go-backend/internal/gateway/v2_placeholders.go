package gateway

import "net/http"

func (s *Server) registerV2Placeholders(mux *http.ServeMux) {
	mux.HandleFunc("POST /v2/auth/register", s.notImplementedV2)
	mux.HandleFunc("POST /v2/auth/login", s.notImplementedV2)
	mux.HandleFunc("POST /v2/auth/refresh", s.notImplementedV2)
	mux.HandleFunc("POST /v2/auth/logout", s.notImplementedV2)
	mux.HandleFunc("POST /v2/rooms", s.notImplementedV2)
	mux.HandleFunc("POST /v2/rooms/{roomId}/admission", s.notImplementedV2)
	mux.HandleFunc("POST /v2/rooms/{roomId}/ws-ticket", s.notImplementedV2)
	mux.HandleFunc("GET /v2/rooms/{roomId}/members", s.notImplementedV2)
	mux.HandleFunc("GET /v2/rooms/{roomId}/pages", s.notImplementedV2)
	mux.HandleFunc("PATCH /v2/rooms/{roomId}/members/{userId}", s.notImplementedV2)
	mux.HandleFunc("POST /v2/rooms/{roomId}/members/{userId}/kick", s.notImplementedV2)
	mux.HandleFunc("POST /v2/rooms/{roomId}/members/{userId}/ban", s.notImplementedV2)
	mux.HandleFunc("POST /v2/rooms/{roomId}/members/{userId}/unban", s.notImplementedV2)
	mux.HandleFunc("PATCH /v2/rooms/{roomId}/role-policies/{role}", s.notImplementedV2)
}

func (s *Server) notImplementedV2(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotImplemented, map[string]any{
		"code": "NOT_IMPLEMENTED",
		"msg":  "v2 auth and permission flow is reserved for the next migration phase",
	})
}
