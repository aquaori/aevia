package gateway

import "net/http"

func (s *Server) registerV2Placeholders(mux *http.ServeMux) {
	mux.HandleFunc("POST /v2/auth/register", s.registerAccount)
	mux.HandleFunc("POST /v2/auth/login", s.loginAccount)
	mux.HandleFunc("POST /v2/auth/refresh", s.notImplementedV2)
	mux.HandleFunc("GET /v2/auth/me", s.accountProfile)
	mux.HandleFunc("PATCH /v2/auth/me", s.updateAccountProfile)
	mux.HandleFunc("POST /v2/auth/logout", s.logoutAccount)
	mux.HandleFunc("POST /v2/rooms", s.createAccountRoom)
	mux.HandleFunc("GET /v2/rooms", s.listAccountRooms)
	mux.HandleFunc("POST /v2/rooms/{roomId}/admission", s.notImplementedV2)
	mux.HandleFunc("POST /v2/rooms/{roomId}/ws-ticket", s.notImplementedV2)
	mux.HandleFunc("GET /v2/rooms/{roomId}/members", s.roomMembers)
	mux.HandleFunc("GET /v2/rooms/{roomId}/settings", s.getRoomSettings)
	mux.HandleFunc("PATCH /v2/rooms/{roomId}/settings", s.updateRoomSettings)
	mux.HandleFunc("POST /v2/rooms/{roomId}/leave", s.leaveRoom)
	mux.HandleFunc("POST /v2/rooms/{roomId}/guests/{userId}", s.changeGuest)
	mux.HandleFunc("POST /v2/rooms/{roomId}/transfer", s.requestTransfer)
	mux.HandleFunc("POST /v2/rooms/{roomId}/transfer/respond", s.respondTransfer)
	mux.HandleFunc("GET /v2/transfers", s.pendingTransfers)
	mux.HandleFunc("DELETE /v2/rooms/{roomId}", s.deleteRoom)
	mux.HandleFunc("GET /v2/rooms/{roomId}/pages", s.notImplementedV2)
	mux.HandleFunc("PATCH /v2/rooms/{roomId}/members/{userId}", s.changeMemberRole)
	mux.HandleFunc("POST /v2/rooms/{roomId}/members/{userId}/kick", s.kickMember)
	mux.HandleFunc("POST /v2/rooms/{roomId}/members/{userId}/ban", s.banMember)
	mux.HandleFunc("POST /v2/rooms/{roomId}/members/{userId}/unban", s.unbanMember)
	mux.HandleFunc("PATCH /v2/rooms/{roomId}/role-policies/{role}", s.notImplementedV2)
}

func (s *Server) notImplementedV2(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotImplemented, map[string]any{
		"code": "NOT_IMPLEMENTED",
		"msg":  "v2 auth and permission flow is reserved for the next migration phase",
	})
}
