package gateway

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"collaborative-whiteboard/apps/go-backend/internal/config"
)

type tokenBucket struct {
	rate   float64
	burst  float64
	tokens float64
	last   time.Time
}

func newTokenBucket(rate, burst int) tokenBucket {
	now := time.Now()
	return tokenBucket{rate: float64(rate), burst: float64(burst), tokens: float64(burst), last: now}
}

func (b *tokenBucket) allow(now time.Time) bool {
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

type keyedBuckets struct {
	mu      sync.Mutex
	rate    int
	burst   int
	buckets map[string]tokenBucket
}

func newKeyedBuckets(rate, burst int) *keyedBuckets {
	return &keyedBuckets{rate: rate, burst: burst, buckets: make(map[string]tokenBucket)}
}

func (b *keyedBuckets) Allow(key string) bool {
	if key == "" {
		key = "unknown"
	}
	now := time.Now()
	b.mu.Lock()
	defer b.mu.Unlock()
	bucket, ok := b.buckets[key]
	if !ok {
		bucket = newTokenBucket(b.rate, b.burst)
	}
	allowed := bucket.allow(now)
	b.buckets[key] = bucket
	return allowed
}

type connectionLimiter struct {
	mu      sync.Mutex
	maxAll  int
	maxIP   int
	maxRoom int
	total   int
	byIP    map[string]int
	byRoom  map[string]int
}

func newConnectionLimiter(cfg config.Config) *connectionLimiter {
	return &connectionLimiter{
		maxAll: cfg.MaxConnections, maxIP: cfg.MaxConnectionsPerIP, maxRoom: cfg.MaxConnectionsPerRoom,
		byIP: make(map[string]int), byRoom: make(map[string]int),
	}
}

func (l *connectionLimiter) Acquire(ip, roomID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.total >= l.maxAll || l.byIP[ip] >= l.maxIP || l.byRoom[roomID] >= l.maxRoom {
		return false
	}
	l.total++
	l.byIP[ip]++
	l.byRoom[roomID]++
	return true
}

func (l *connectionLimiter) Release(ip, roomID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.total > 0 {
		l.total--
	}
	decrement(l.byIP, ip)
	decrement(l.byRoom, roomID)
}

func (l *connectionLimiter) Snapshot() map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	return map[string]any{
		"total": l.total,
		"ips":   len(l.byIP),
		"rooms": len(l.byRoom),
		"limits": map[string]any{
			"global":  l.maxAll,
			"perIp":   l.maxIP,
			"perRoom": l.maxRoom,
		},
	}
}

func decrement(values map[string]int, key string) {
	if key == "" {
		return
	}
	if values[key] <= 1 {
		delete(values, key)
		return
	}
	values[key]--
}

type wsEventLimiter struct {
	realtime tokenBucket
	reliable tokenBucket
	mu       sync.Mutex
}

func newWSEventLimiter(cfg config.Config) *wsEventLimiter {
	return &wsEventLimiter{
		realtime: newTokenBucket(cfg.WSRealtimePerSecond, cfg.WSRealtimeBurst),
		reliable: newTokenBucket(cfg.WSReliablePerSecond, cfg.WSReliableBurst),
	}
}

func (l *wsEventLimiter) Allow(typ string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if isRealtimeEvent(typ) {
		return l.realtime.allow(now)
	}
	return l.reliable.allow(now)
}

func isRealtimeEvent(typ string) bool {
	return typ == "mouseMove" || typ == "mouseLeave" || typ == "box-selection"
}

func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		return strings.TrimSpace(strings.Split(forwarded, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
