package config

import (
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Host                   string
	Port                   int
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
	HashPoolSize           int
	HashQueueTimeout       time.Duration
	WALCheckpointInterval  time.Duration
	WALCheckpointBytes     int64
	WALTruncateBytes       int64
	PprofAddr              string
	LogLevel               slog.Level
}

func Load() Config {
	return Config{
		Host:                   envString("HOST", "0.0.0.0"),
		Port:                   envInt("PORT", 4647, 1, 65535),
		DBPath:                 envString("DB_PATH", filepath.Join("data", "whiteboard-go.sqlite")),
		JWTSecret:              envString("JWT_SECRET", "aevia-go-dev-secret"),
		DefaultRoomID:          envString("DEFAULT_ROOM_ID", "123123"),
		SessionTTL:             envDuration("SESSION_TOKEN_TTL", 30*time.Minute),
		InviteTTL:              envDuration("INVITE_TOKEN_TTL", 24*time.Hour),
		InitPreloadPageCount:   envInt("INIT_PRELOAD_PAGE_COUNT", 2, 0, 20),
		PageCacheRadius:        envInt("PAGE_CACHE_RADIUS", 1, 0, 20),
		InitCommandChunkSize:   envInt("INIT_COMMAND_CHUNK_SIZE", 100, 1, 5000),
		InitFlatPointChunkSize: envInt("INIT_FLAT_POINT_CHUNK_SIZE", 2000, 1, 100000),
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
		HashPoolSize:           envInt("HASH_POOL_SIZE", 2, 1, 128),
		HashQueueTimeout:       time.Duration(envInt("HASH_QUEUE_TIMEOUT_MS", 1500, 1, 60000)) * time.Millisecond,
		WALCheckpointInterval:  time.Duration(envInt("WAL_CHECKPOINT_INTERVAL_MS", 30000, 1000, 3600000)) * time.Millisecond,
		WALCheckpointBytes:     int64(envInt("WAL_CHECKPOINT_BYTES", 64*1024*1024, 1024*1024, 1024*1024*1024)),
		WALTruncateBytes:       int64(envInt("WAL_TRUNCATE_BYTES", 256*1024*1024, 1024*1024, 2*1024*1024*1024)),
		PprofAddr:              envString("PPROF_ADDR", ""),
		LogLevel:               slog.LevelInfo,
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
