package gateway

import (
	"net/http"

	"collaborative-whiteboard/apps/backend/internal/apg"
)

func (s *Server) apgCatalog(w http.ResponseWriter, r *http.Request) {
	if !s.apgCatalogBudget.Allow(s.ipResolver.ClientIP(r)) {
		w.Header().Set("Retry-After", "1")
		fail(w, http.StatusTooManyRequests, "APG catalog rate limit exceeded")
		return
	}
	store, err := apg.LoadTrustStore(s.cfg.APGTrustStore)
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "APG trust store is invalid")
		return
	}
	catalog, err := apg.LoadCatalogWithTrust(s.cfg.APGDir, store, apg.TrustPolicy(s.cfg.APGTrustPolicy))
	if err != nil {
		fail(w, http.StatusServiceUnavailable, "APG catalog is invalid")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, catalog)
}
