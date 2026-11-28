package gateway

import (
	"net/http"
	"sync/atomic"
	"time"

	"collaborative-whiteboard/apps/backend/internal/auth"
	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/room"
	"collaborative-whiteboard/apps/backend/internal/storage"
)

type Server struct {
	cfg             config.Config
	store           *storage.Store
	registry        *room.Registry
	tokens          auth.TokenService
	started         time.Time
	sessionEpoch    int64
	draining        atomic.Bool
	httpLimiter     *keyedBuckets
	authLimiter     *keyedBuckets
	connectionLimit *connectionLimiter
	ipResolver      *clientIPResolver
	// APG catalog and asset endpoints are unauthenticated reads of
	// deployment-owned files, so they get their own per-client budgets. The
	// budgets bound how fast one client can make the server re-scan the
	// package directory or stream archived assets; they never grant anything.
	apgCatalogBudget *keyedBuckets
	apgAssetBudget   *keyedBuckets
	// Room shared state is authenticated, but a plugin can still drive a write
	// loop; separate read and write budgets keep a noisy plugin from hammering
	// CAS queries and state-changed broadcasts for everyone in the room.
	apgStateReadBudget  *keyedBuckets
	apgStateWriteBudget *keyedBuckets
}

// NewServer wires the HTTP/WS gateway. sessionEpoch is the unix-second boundary
// before which session tokens are considered stale; it is persisted by the store
// so restarts and sibling instances agree (see Store.SessionEpoch).
func NewServer(cfg config.Config, store *storage.Store, registry *room.Registry, sessionEpoch int64) *Server {
	return &Server{
		cfg:          cfg,
		store:        store,
		registry:     registry,
		tokens:       auth.NewTokenService(cfg.JWTSecret),
		started:      time.Now(),
		sessionEpoch: sessionEpoch,
		httpLimiter: newKeyedBuckets(
			float64(cfg.HTTPRequestsPerSecond), cfg.HTTPRequestsBurst, cfg.RateLimitIdleTTL, cfg.RateLimitMaxKeys,
		),
		// Budget for *failed* password attempts only, so brute force is cut off
		// without penalising legitimate joins.
		authLimiter: newKeyedBuckets(
			float64(cfg.AuthFailuresPerMinute)/60, cfg.AuthFailureBurst, cfg.RateLimitIdleTTL, cfg.RateLimitMaxKeys,
		),
		connectionLimit: newConnectionLimiter(cfg),
		ipResolver:      newClientIPResolver(cfg),
		// 40 catalog reads with a refill of 2/s tolerate a page refresh and the
		// 15s poll from several tabs while still stopping a directory-scan loop.
		apgCatalogBudget: newKeyedBuckets(2, 40, cfg.RateLimitIdleTTL, cfg.RateLimitMaxKeys),
		// Assets are content-addressed and cached by the browser, but one
		// template can load several; allow bursts while keeping a ceiling.
		apgAssetBudget: newKeyedBuckets(10, 120, cfg.RateLimitIdleTTL, cfg.RateLimitMaxKeys),
		// Reads are cheap and happen on every command; writes are rarer, so they
		// get a smaller burst and a slower refill.
		apgStateReadBudget:  newKeyedBuckets(20, 60, cfg.RateLimitIdleTTL, cfg.RateLimitMaxKeys),
		apgStateWriteBudget: newKeyedBuckets(4, 12, cfg.RateLimitIdleTTL, cfg.RateLimitMaxKeys),
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", s.live)
	mux.HandleFunc("GET /health/ready", s.ready)
	mux.HandleFunc("GET /debug/metrics", s.metrics)
	mux.HandleFunc("GET /api/apg/catalog", s.apgCatalog)
	mux.HandleFunc("GET /api/apg/state/{id}", s.withSession(s.apgState))
	mux.HandleFunc("PUT /api/apg/state/{id}", s.withSession(s.apgState))
	mux.HandleFunc("GET /api/apg/asset/{digest}/{name...}", s.apgAsset)
	mux.HandleFunc("POST /create-room", s.createRoom)
	mux.HandleFunc("GET /check-room", s.checkRoom)
	mux.HandleFunc("GET /generate-room-id", s.generateRoomID)
	mux.HandleFunc("POST /join-room", s.joinRoom)
	mux.HandleFunc("GET /generate-share-token", s.withSession(s.generateShareToken))
	mux.HandleFunc("GET /room-invites", s.withSession(s.listRoomInvites))
	mux.HandleFunc("POST /room-invites/revoke", s.withSession(s.revokeRoomInvite))
	mux.HandleFunc("GET /get-token-info", s.getTokenInfo)
	mux.HandleFunc("GET /get-page-review", s.withSession(s.getPageReview))
	mux.HandleFunc("POST /renew-room-session", s.withSession(s.renewSession))
	mux.HandleFunc("GET /ws", s.websocket)
	s.registerV2Placeholders(mux)
	return s.withCORS(s.limitHTTPRate(limitBody(mux, s.cfg.MaxHTTPBodyBytes)))
}

func (s *Server) BeginDraining() {
	if s.draining.CompareAndSwap(false, true) {
		s.registry.BeginDraining("server is draining")
	}
}
