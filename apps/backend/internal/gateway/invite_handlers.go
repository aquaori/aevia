package gateway

import "net/http"

func (s *Server) listRoomInvites(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r)
	if !s.canShareRoom(w, r, claims) {
		return
	}
	invites, err := s.store.Invites(r.Context(), claims.RoomID)
	if err != nil {
		fail(w, 500, "无法获取邀请")
		return
	}
	ok(w, invites)
}

func (s *Server) revokeRoomInvite(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r)
	if !s.canShareRoom(w, r, claims) {
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if decodeJSON(r, &req) != nil || req.ID == "" {
		fail(w, 400, "邀请无效")
		return
	}
	if err := s.store.RevokeInvite(r.Context(), claims.RoomID, req.ID); err != nil {
		fail(w, 500, "无法撤销邀请")
		return
	}
	okNoData(w)
}
