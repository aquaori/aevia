package gateway

import (
	"net/http"
	"sync/atomic"
	"time"

	"collaborative-whiteboard/apps/go-backend/internal/auth"
	"collaborative-whiteboard/apps/go-backend/internal/config"
	"collaborative-whiteboard/apps/go-backend/internal/room"
	"collaborative-whiteboard/apps/go-backend/internal/storage"
)

type Server struct {
	cfg             config.Config
	store           *storage.Store
	registry        *room.Registry
	tokens          auth.TokenService
	started         time.Time
	draining        atomic.Bool
	httpLimiter     *keyedBuckets
	connectionLimit *connectionLimiter
}

func NewServer(cfg config.Config, store *storage.Store, registry *room.Registry) *Server {
	return &Server{
		cfg:             cfg,
		store:           store,
		registry:        registry,
		tokens:          auth.NewTokenService(cfg.JWTSecret),
		started:         time.Now(),
		httpLimiter:     newKeyedBuckets(cfg.HTTPRequestsPerSecond, cfg.HTTPRequestsBurst),
		connectionLimit: newConnectionLimiter(cfg),
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", s.live)
	mux.HandleFunc("GET /health/ready", s.ready)
	mux.HandleFunc("GET /debug/metrics", s.metrics)
	mux.HandleFunc("POST /create-room", s.createRoom)
	mux.HandleFunc("GET /check-room", s.checkRoom)
	mux.HandleFunc("GET /generate-room-id", s.generateRoomID)
	mux.HandleFunc("POST /join-room", s.joinRoom)
	mux.HandleFunc("GET /generate-share-token", s.withSession(s.generateShareToken))
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
