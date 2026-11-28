package gateway

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"collaborative-whiteboard/apps/backend/internal/apg"
	"collaborative-whiteboard/apps/backend/internal/storage"
)

func (s *Server) apgState(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, valid := claimsFrom(r)
	if !valid {
		fail(w, 401, "Session required")
		return
	}
	budget := s.apgStateReadBudget
	if r.Method != http.MethodGet {
		budget = s.apgStateWriteBudget
	}
	if budget != nil && !budget.Allow(s.ipResolver.ClientIP(r)) {
		w.Header().Set("Retry-After", "1")
		fail(w, http.StatusTooManyRequests, "APG state rate limit exceeded")
		return
	}
	id, digest := r.PathValue("id"), r.URL.Query().Get("digest")
	store, err := apg.LoadTrustStore(s.cfg.APGTrustStore)
	if err != nil {
		fail(w, 503, "APG unavailable")
		return
	}
	catalog, err := apg.LoadCatalogWithTrust(s.cfg.APGDir, store, apg.TrustPolicy(s.cfg.APGTrustPolicy))
	if err != nil {
		fail(w, 503, "APG unavailable")
		return
	}
	allowed := false
	stateSchemaVersion := 0
	for _, p := range catalog.Plugins {
		if p.Manifest.ID == id && p.Digest == digest && p.Manifest.Scope == "system" {
			for _, perm := range p.Manifest.Permissions {
				if perm == "storage.shared" {
					allowed = true
					// The schema version is taken from the signed manifest, never from the
					// request, so a client cannot downgrade state written by a newer plugin.
					stateSchemaVersion = p.Manifest.StateSchemaVersion
				}
			}
		}
	}
	if !allowed {
		fail(w, 403, "APG state permission or version denied")
		return
	}
	if r.Method == http.MethodGet {
		state, err := s.store.ReadAPGState(r.Context(), claims.RoomID, id)
		if err != nil {
			fail(w, 500, "APG state read failed")
			return
		}
		ok(w, state)
		return
	}
	role := ""
	denied := false
	if claims.Account {
		role, denied, err = s.store.MemberRole(r.Context(), claims.RoomID, claims.UserID)
	} else {
		role, denied, err = s.store.GuestRole(r.Context(), claims.RoomID, claims.UserID)
	}
	if err != nil || denied || (role != "editor" && role != "owner") {
		fail(w, 403, "Room write denied")
		return
	}
	var req struct {
		Revision *int64          `json:"revision"`
		Value    json.RawMessage `json:"value"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20*1024))
	d.DisallowUnknownFields()
	if err := d.Decode(&req); err != nil || req.Revision == nil || *req.Revision < 0 || *req.Revision >= 9007199254740991 || len(req.Value) > 16384 || !json.Valid(req.Value) {
		fail(w, 400, "Invalid APG state")
		return
	}
	if err := d.Decode(new(any)); err != io.EOF {
		fail(w, 400, "Invalid APG state")
		return
	}
	changed, err := s.store.WriteAPGStateAuthorized(r.Context(), claims.RoomID, id, claims.UserID, claims.Account, *req.Revision, stateSchemaVersion, req.Value)
	if err != nil {
		switch {
		case errors.Is(err, storage.ErrAPGWriteUnauthorized):
			fail(w, 403, "Room write denied")
		case errors.Is(err, storage.ErrAPGStateSchemaConflict):
			fail(w, 409, "APG state schema conflict")
		case errors.Is(err, storage.ErrAPGStateConflict):
			fail(w, 409, "APG state revision conflict")
		default:
			fail(w, 500, "APG state write failed")
		}
		return
	}
	if !changed {
		fail(w, 409, "APG state revision conflict")
		return
	}
	if s.registry != nil {
		s.registry.NotifyAPGState(claims.RoomID, id, digest, *req.Revision+1)
	}
	ok(w, map[string]any{"revision": *req.Revision + 1, "schemaVersion": stateSchemaVersion, "value": req.Value})
}

// Package resource reads are content-addressed and only serve data; no HTML or JS execution.
func (s *Server) apgAsset(w http.ResponseWriter, r *http.Request) {
	if !s.apgAssetBudget.Allow(s.ipResolver.ClientIP(r)) {
		w.Header().Set("Retry-After", "1")
		fail(w, http.StatusTooManyRequests, "APG asset rate limit exceeded")
		return
	}
	digest, name := r.PathValue("digest"), r.PathValue("name")
	if !apg.ValidDigest(digest) || !strings.HasPrefix(name, "assets/") {
		fail(w, 404, "Resource not found")
		return
	}
	data, err := apg.ReadArchivedAsset(s.cfg.APGDir, digest, name)
	if err != nil {
		fail(w, 404, "Resource not found")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "attachment")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(data)
}
