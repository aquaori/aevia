package gateway

import (
	"log/slog"
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

func newTokenBucket(ratePerSecond float64, burst int) tokenBucket {
	now := time.Now()
	return tokenBucket{rate: ratePerSecond, burst: float64(burst), tokens: float64(burst), last: now}
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

// keyedBuckets holds one token bucket per key (usually a client IP). Entries are
// evicted once they have been idle long enough to have refilled to full, so a
// stream of distinct keys cannot grow the map without bound. maxKeys is a hard
// backstop: once reached, admission is denied for unseen keys rather than
// allocating, which keeps a spoofed-key flood from exhausting memory.
type keyedBuckets struct {
	mu        sync.Mutex
	rate      float64
	burst     int
	idleTTL   time.Duration
	maxKeys   int
	buckets   map[string]tokenBucket
	lastPurge time.Time
}

func newKeyedBuckets(ratePerSecond float64, burst int, idleTTL time.Duration, maxKeys int) *keyedBuckets {
	if idleTTL <= 0 {
		idleTTL = 10 * time.Minute
	}
	if maxKeys <= 0 {
		maxKeys = 50000
	}
	return &keyedBuckets{
		rate: ratePerSecond, burst: burst, idleTTL: idleTTL, maxKeys: maxKeys,
		buckets: make(map[string]tokenBucket), lastPurge: time.Now(),
	}
}

func (b *keyedBuckets) Allow(key string) bool {
	if key == "" {
		key = "unknown"
	}
	now := time.Now()
	b.mu.Lock()
	defer b.mu.Unlock()

	b.purgeLocked(now)

	bucket, ok := b.buckets[key]
	if !ok {
		if len(b.buckets) >= b.maxKeys {
			// Table is saturated. Refuse rather than grow; a legitimate client
			// retries once churn frees a slot.
			return false
		}
		bucket = newTokenBucket(b.rate, b.burst)
	}
	allowed := bucket.allow(now)
	b.buckets[key] = bucket
	return allowed
}

// purgeLocked drops buckets that have been idle long enough that recreating
// them yields identical behaviour. Amortised: runs at most once per idleTTL.
func (b *keyedBuckets) purgeLocked(now time.Time) {
	if now.Sub(b.lastPurge) < b.idleTTL {
		return
	}
	b.lastPurge = now
	cutoff := now.Add(-b.idleTTL)
	for key, bucket := range b.buckets {
		if bucket.last.Before(cutoff) {
			delete(b.buckets, key)
		}
	}
}

func (b *keyedBuckets) Size() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.buckets)
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
		realtime: newTokenBucket(float64(cfg.WSRealtimePerSecond), cfg.WSRealtimeBurst),
		reliable: newTokenBucket(float64(cfg.WSReliablePerSecond), cfg.WSReliableBurst),
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

// clientIPResolver turns a request into the identity used for per-IP rate and
// connection limits.
//
// X-Forwarded-For is attacker-controlled unless a proxy we trust rewrote it, so
// it is only consulted when TRUST_PROXY_HEADERS is enabled and — if
// TRUSTED_PROXIES is set — the immediate peer is in that list. Otherwise the
// header is ignored and the TCP peer address is used. Trusting it
// unconditionally let a single client bypass every per-IP limit by varying the
// header, and allocate an unbounded number of limiter buckets doing it.
type clientIPResolver struct {
	trustHeaders bool
	trusted      []*net.IPNet
}

func newClientIPResolver(cfg config.Config) *clientIPResolver {
	resolver := &clientIPResolver{trustHeaders: cfg.TrustProxyHeaders}
	for _, entry := range cfg.TrustedProxies {
		if network := parseCIDROrIP(entry); network != nil {
			resolver.trusted = append(resolver.trusted, network)
		} else {
			slog.Warn("ignoring unparseable TRUSTED_PROXIES entry", "entry", entry)
		}
	}
	return resolver
}

func (c *clientIPResolver) ClientIP(r *http.Request) string {
	peer := peerIP(r)
	if !c.trustHeaders || !c.peerMayForward(peer) {
		return peer
	}

	forwarded := parseForwardedChain(r.Header.Get("X-Forwarded-For"))
	if len(forwarded) > 0 {
		if len(c.trusted) > 0 {
			// With a known trust boundary, the right-most address that is not one
			// of our own proxies is the closest hop we can actually attribute.
			// Entries to its left are attacker-supplied.
			for index := len(forwarded) - 1; index >= 0; index-- {
				if !c.isTrustedProxy(forwarded[index]) {
					return forwarded[index]
				}
			}
			// Every hop was one of ours; the originator is the left-most entry.
			return forwarded[0]
		}
		// No trust boundary configured, so we cannot tell how many hops belong to
		// us. Assume a single trusted proxy and take the originator it recorded.
		return forwarded[0]
	}

	if real := strings.TrimSpace(r.Header.Get("X-Real-Ip")); real != "" && net.ParseIP(real) != nil {
		return real
	}
	return peer
}

// peerMayForward reports whether the immediate peer is allowed to set forwarding
// headers. When TRUSTED_PROXIES is empty every peer is accepted, which is only
// safe if the process is not reachable directly — hence the startup hint to
// configure the list.
func (c *clientIPResolver) peerMayForward(addr string) bool {
	if len(c.trusted) == 0 {
		return true
	}
	return c.isTrustedProxy(addr)
}

func (c *clientIPResolver) isTrustedProxy(addr string) bool {
	ip := net.ParseIP(addr)
	if ip == nil {
		return false
	}
	for _, network := range c.trusted {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// parseForwardedChain returns the valid IPs in an X-Forwarded-For header, in
// header order (originator first), discarding malformed entries.
func parseForwardedChain(header string) []string {
	if header == "" {
		return nil
	}
	parts := strings.Split(header, ",")
	chain := make([]string, 0, len(parts))
	for _, part := range parts {
		candidate := strings.TrimSpace(part)
		if candidate == "" || net.ParseIP(candidate) == nil {
			continue
		}
		chain = append(chain, candidate)
	}
	return chain
}

func peerIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func isLoopback(addr string) bool {
	ip := net.ParseIP(addr)
	return ip != nil && ip.IsLoopback()
}

func parseCIDROrIP(entry string) *net.IPNet {
	entry = strings.TrimSpace(entry)
	if entry == "" {
		return nil
	}
	if _, network, err := net.ParseCIDR(entry); err == nil {
		return network
	}
	ip := net.ParseIP(entry)
	if ip == nil {
		return nil
	}
	bits := 32
	if ip.To4() == nil {
		bits = 128
	}
	return &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)}
}
