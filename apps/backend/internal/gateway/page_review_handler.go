package gateway

import "net/http"

func (s *Server) getPageReview(w http.ResponseWriter, r *http.Request) {
	claims, _ := claimsFrom(r)
	actor, err := s.registry.Get(r.Context(), claims.RoomID)
	if err != nil {
		fail(w, http.StatusBadRequest, "Room does not exist")
		return
	}
	review, err := actor.PageReview()
	if err != nil {
		fail(w, http.StatusInternalServerError, "Page review failed")
		return
	}
	ok(w, review)
}
