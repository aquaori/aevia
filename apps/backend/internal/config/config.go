package config

import (
	"errors"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// DevJWTSecret is the throwaway secret used when JWT_SECRET is unset outside
// production. Load refuses to start in production without an explicit secret.
const DevJWTSecret = "aevia-go-dev-secret"

// MaxRenderChunkPoints bounds a render chunk so its per-chunk command
// dictionary index always fits the uint16 field in the binary frame. See
// protocol.EncodeRenderChunk.
const MaxRenderChunkPoints = 65535

type Config struct {
	Host                   string
	Port                   int
	Environment            string
	DBPath                 string
	JWTSecret              string
	DefaultRoomID          string
	SessionTTL             time.Duration
	InviteTTL              time.Duration
	InitPreloadPageCount   int
	PageCacheRadius        int
	InitCommandChunkSize   int
	InitFlatPointChunkSize int
	PageChangeDebounce     time.Duration
	WSMaxPayloadBytes      int64
	WSJSONMaxBytes         int64
	WSMaxPointsPerCommand  int
	WSMaxPointsPerUpdate   int
	WSMaxBatchCommands     int
	ConnectionSendBytes    int
	ConnectionSendMessages int
	RoomReliableQueue      int
	RoomRealtimeQueue      int
	DBBatchSize            int
	DBBatchWindow          time.Duration
	MaxHTTPBodyBytes       int64
	AllowedOrigins         []string
	MaxConnections         int
	MaxConnectionsPerIP    int
	MaxConnectionsPerRoom  int
	HTTPRequestsPerSecond  int
	HTTPRequestsBurst      int
	WSRealtimePerSecond    int
	WSRealtimeBurst        int
	WSReliablePerSecond    int
	WSReliableBurst        int
	AuthFailuresPerMinute  int
	AuthFailureBurst       int
	RateLimitIdleTTL       time.Duration
	RateLimitMaxKeys       int
	TrustProxyHeaders      bool
	TrustedProxies         []string
	WSHeartbeatInterval    time.Duration
	WSPongTimeout          time.Duration
	HashPoolSize           int
	HashQueueTimeout       time.Duration
	WALCheckpointInterval  time.Duration
	WALCheckpointBytes     int64
	WALTruncateBytes       int64
	PprofAddr              string
	LogLevel               slog.Level
}

// Load reads configuration from the environment. It returns an error for
// misconfiguration that must not be silently defaulted away — currently a
// missing JWT secret in production, which would otherwise let anyone forge
// room session tokens against the well-known development secret.
func Load() (Config, error) {
	cfg := load()
	environment := strings.ToLower(cfg.Environment)
	if environment == "production" || environment == "prod" {
		if strings.TrimSpace(os.Getenv("JWT_SECRET")) == "" {
			return Config{}, errors.New("JWT_SECRET must be configured in production")
		}
		if len(cfg.AllowedOrigins) == 1 && cfg.AllowedOrigins[0] == "*" {
			slog.Warn("ALLOWED_ORIGINS is '*' in production; set an explicit origin allowlist")
		}
		if !cfg.TrustProxyHeaders {
			slog.Info("X-Forwarded-For is ignored; set TRUST_PROXY_HEADERS=1 when running behind a trusted proxy")
		}
	} else if strings.TrimSpace(os.Getenv("JWT_SECRET")) == "" {
		slog.Warn("JWT_SECRET is unset; using the public development secret", "secret", DevJWTSecret)
	}
	return cfg, nil
}

// IsProduction reports whether the process is configured for a production
// deployment.
func (c Config) IsProduction() bool {
	environment := strings.ToLower(c.Environment)
	return environment == "production" || environment == "prod"
}

func load() Config {
	return Config{
		Host:                   envString("HOST", "0.0.0.0"),
		Port:                   envInt("PORT", 4646, 1, 65535),
		Environment:            envString("APP_ENV", envString("NODE_ENV", "development")),
		DBPath:                 envString("DB_PATH", filepath.Join("data", "whiteboard-go.sqlite")),
		JWTSecret:              envString("JWT_SECRET", DevJWTSecret),
		DefaultRoomID:          envString("DEFAULT_ROOM_ID", "123123"),
		SessionTTL:             envDuration("SESSION_TOKEN_TTL", 30*time.Minute),
		InviteTTL:              envDuration("INVITE_TOKEN_TTL", 24*time.Hour),
		InitPreloadPageCount:   envInt("INIT_PRELOAD_PAGE_COUNT", 2, 0, 20),
		PageCacheRadius:        envInt("PAGE_CACHE_RADIUS", 1, 0, 20),
		InitCommandChunkSize:   envInt("INIT_COMMAND_CHUNK_SIZE", 100, 1, 5000),
		InitFlatPointChunkSize: envInt("INIT_FLAT_POINT_CHUNK_SIZE", 2000, 1, MaxRenderChunkPoints),
		PageChangeDebounce:     time.Duration(envInt("PAGE_CHANGE_DEBOUNCE_MS", 80, 0, 10000)) * time.Millisecond,
		WSMaxPayloadBytes:      int64(envInt("WS_MAX_PAYLOAD_BYTES", 256*1024, 1024, 16*1024*1024)),
		WSJSONMaxBytes:         int64(envInt("WS_JSON_MAX_BYTES", 256*1024, 1024, 16*1024*1024)),
		WSMaxPointsPerCommand:  envInt("WS_MAX_POINTS_PER_COMMAND", 20000, 1, 100000),
		WSMaxPointsPerUpdate:   envInt("WS_MAX_POINTS_PER_UPDATE", 2000, 1, 65535),
		WSMaxBatchCommands:     envInt("WS_MAX_BATCH_COMMANDS", 200, 1, 5000),
		ConnectionSendBytes:    envInt("CONNECTION_SEND_BYTES", 4*1024*1024, 64*1024, 64*1024*1024),
		ConnectionSendMessages: envInt("CONNECTION_SEND_MESSAGES", 256, 8, 4096),
		RoomReliableQueue:      envInt("ROOM_RELIABLE_QUEUE", 4096, 16, 100000),
		RoomRealtimeQueue:      envInt("ROOM_REALTIME_QUEUE", 2048, 16, 100000),
		DBBatchSize:            envInt("DB_BATCH_SIZE", 128, 1, 10000),
		DBBatchWindow:          time.Duration(envInt("DB_BATCH_WINDOW_MS", 5, 1, 1000)) * time.Millisecond,
		MaxHTTPBodyBytes:       int64(envInt("MAX_HTTP_BODY_BYTES", 1<<20, 1024, 64*1024*1024)),
		AllowedOrigins:         envList("ALLOWED_ORIGINS", []string{"*"}),
		MaxConnections:         envInt("MAX_CONNECTIONS", 6000, 1, 1000000),
		MaxConnectionsPerIP:    envInt("MAX_CONNECTIONS_PER_IP", 512, 1, 100000),
		MaxConnectionsPerRoom:  envInt("MAX_CONNECTIONS_PER_ROOM", 1000, 1, 100000),
		HTTPRequestsPerSecond:  envInt("HTTP_REQUESTS_PER_SECOND", 120, 1, 100000),
		HTTPRequestsBurst:      envInt("HTTP_REQUESTS_BURST", 240, 1, 100000),
		WSRealtimePerSecond:    envInt("WS_REALTIME_PER_SECOND", 90, 1, 100000),
		WSRealtimeBurst:        envInt("WS_REALTIME_BURST", 180, 1, 100000),
		WSReliablePerSecond:    envInt("WS_RELIABLE_PER_SECOND", 120, 1, 100000),
		WSReliableBurst:        envInt("WS_RELIABLE_BURST", 240, 1, 100000),
		AuthFailuresPerMinute:  envInt("AUTH_FAILURES_PER_MINUTE", 20, 1, 100000),
		AuthFailureBurst:       envInt("AUTH_FAILURE_BURST", 10, 1, 100000),
		RateLimitIdleTTL: time.Duration(envInt("RATE_LIMIT_IDLE_TTL_MS", 600000, 1000, 86400000)) *
			time.Millisecond,
		RateLimitMaxKeys:  envInt("RATE_LIMIT_MAX_KEYS", 50000, 128, 5000000),
		TrustProxyHeaders: envBool("TRUST_PROXY_HEADERS", false),
		TrustedProxies:    envList("TRUSTED_PROXIES", nil),
		WSHeartbeatInterval: time.Duration(envInt("WS_HEARTBEAT_INTERVAL_MS", 25000, 1000, 600000)) *
			time.Millisecond,
		WSPongTimeout: time.Duration(envInt("WS_PONG_TIMEOUT_MS", 10000, 500, 120000)) *
			time.Millisecond,
		HashPoolSize:          envInt("HASH_POOL_SIZE", 2, 1, 128),
		HashQueueTimeout:      time.Duration(envInt("HASH_QUEUE_TIMEOUT_MS", 1500, 1, 60000)) * time.Millisecond,
		WALCheckpointInterval: time.Duration(envInt("WAL_CHECKPOINT_INTERVAL_MS", 30000, 1000, 3600000)) * time.Millisecond,
		WALCheckpointBytes:    int64(envInt("WAL_CHECKPOINT_BYTES", 64*1024*1024, 1024*1024, 1024*1024*1024)),
		WALTruncateBytes:      int64(envInt("WAL_TRUNCATE_BYTES", 256*1024*1024, 1024*1024, 2*1024*1024*1024)),
		PprofAddr:             envString("PPROF_ADDR", ""),
		LogLevel:              slog.LevelInfo,
	}
}

func (c Config) Addr() string {
	return net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
}

func envString(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback, min, max int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < min || value > max {
		return fallback
	}
	return value
}

func envBool(name string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "":
		return fallback
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func envDuration(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	if d, err := time.ParseDuration(raw); err == nil {
		return d
	}
	return fallback
}

func envList(name string, fallback []string) []string {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value != "" {
			out = append(out, value)
		}
	}
	if len(out) == 0 {
		return fallback
	}
	return out
}
