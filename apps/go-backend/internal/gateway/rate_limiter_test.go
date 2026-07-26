package gateway

import (
	"net/http/httptest"
	"testing"
	"time"

	"collaborative-whiteboard/apps/go-backend/internal/config"
)

// TestClientIPIgnoresForwardedHeaderByDefault covers the bypass this fix closes:
// trusting X-Forwarded-For unconditionally let one client dodge every per-IP
// limit just by varying the header.
func TestClientIPIgnoresForwardedHeaderByDefault(t *testing.T) {
	resolver := newClientIPResolver(config.Config{})

	request := httptest.NewRequest("GET", "/join-room", nil)
	request.RemoteAddr = "203.0.113.9:5555"
	request.Header.Set("X-Forwarded-For", "1.2.3.4")

	if got := resolver.ClientIP(request); got != "203.0.113.9" {
		t.Fatalf("expected the TCP peer address, got %q", got)
	}
}

func TestClientIPUsesForwardedHeaderWhenTrusted(t *testing.T) {
	resolver := newClientIPResolver(config.Config{TrustProxyHeaders: true})

	request := httptest.NewRequest("GET", "/join-room", nil)
	request.RemoteAddr = "10.0.0.1:5555"
	request.Header.Set("X-Forwarded-For", "1.2.3.4, 10.0.0.1")

	if got := resolver.ClientIP(request); got != "1.2.3.4" {
		t.Fatalf("expected the client address from the chain, got %q", got)
	}
}

func TestClientIPRequiresTrustedPeer(t *testing.T) {
	resolver := newClientIPResolver(config.Config{
		TrustProxyHeaders: true,
		TrustedProxies:    []string{"10.0.0.0/8"},
	})

	trusted := httptest.NewRequest("GET", "/", nil)
	trusted.RemoteAddr = "10.1.2.3:1111"
	trusted.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := resolver.ClientIP(trusted); got != "1.2.3.4" {
		t.Fatalf("trusted proxy: expected 1.2.3.4, got %q", got)
	}

	// An untrusted peer must not be able to claim someone else's address.
	untrusted := httptest.NewRequest("GET", "/", nil)
	untrusted.RemoteAddr = "203.0.113.9:1111"
	untrusted.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := resolver.ClientIP(untrusted); got != "203.0.113.9" {
		t.Fatalf("untrusted peer: expected the peer address, got %q", got)
	}
}

func TestClientIPSkipsInvalidForwardedEntries(t *testing.T) {
	resolver := newClientIPResolver(config.Config{TrustProxyHeaders: true})

	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "10.0.0.1:1111"
	request.Header.Set("X-Forwarded-For", "1.2.3.4, not-an-ip, ")

	if got := resolver.ClientIP(request); got != "1.2.3.4" {
		t.Fatalf("expected malformed entries to be skipped, got %q", got)
	}
}

func TestKeyedBucketsEnforcesBurstAndRefill(t *testing.T) {
	buckets := newKeyedBuckets(100, 2, time.Minute, 1000)

	if !buckets.Allow("a") || !buckets.Allow("a") {
		t.Fatal("expected the burst allowance to be granted")
	}
	if buckets.Allow("a") {
		t.Fatal("expected the third immediate request to be denied")
	}
	// A different key has its own bucket.
	if !buckets.Allow("b") {
		t.Fatal("expected an independent key to be allowed")
	}
}

// TestKeyedBucketsEvictsIdleKeys covers the unbounded-growth half of the limiter
// bug: the bucket map previously had no eviction at all.
func TestKeyedBucketsEvictsIdleKeys(t *testing.T) {
	buckets := newKeyedBuckets(100, 2, 10*time.Millisecond, 1000)

	buckets.Allow("stale-1")
	buckets.Allow("stale-2")
	if buckets.Size() != 2 {
		t.Fatalf("expected 2 tracked keys, got %d", buckets.Size())
	}

	time.Sleep(20 * time.Millisecond)
	buckets.Allow("fresh")

	if size := buckets.Size(); size != 1 {
		t.Fatalf("expected idle keys to be evicted leaving 1, got %d", size)
	}
}

func TestKeyedBucketsRefusesBeyondMaxKeys(t *testing.T) {
	buckets := newKeyedBuckets(100, 5, time.Hour, 2)

	if !buckets.Allow("k1") || !buckets.Allow("k2") {
		t.Fatal("expected the first two keys to be admitted")
	}
	if buckets.Allow("k3") {
		t.Fatal("expected admission to be refused once the key table is saturated")
	}
	if buckets.Size() != 2 {
		t.Fatalf("expected the table to stay at its cap, got %d", buckets.Size())
	}
}

func TestConnectionLimiterAcquireRelease(t *testing.T) {
	limiter := newConnectionLimiter(config.Config{
		MaxConnections: 3, MaxConnectionsPerIP: 2, MaxConnectionsPerRoom: 2,
	})

	if !limiter.Acquire("1.1.1.1", "r1") || !limiter.Acquire("1.1.1.1", "r1") {
		t.Fatal("expected two connections to be admitted")
	}
	if limiter.Acquire("1.1.1.1", "r1") {
		t.Fatal("expected the per-IP cap to reject the third connection")
	}

	limiter.Release("1.1.1.1", "r1")
	if !limiter.Acquire("1.1.1.1", "r1") {
		t.Fatal("expected a freed slot to be reusable")
	}

	limiter.Release("1.1.1.1", "r1")
	limiter.Release("1.1.1.1", "r1")
	snapshot := limiter.Snapshot()
	if snapshot["total"] != 0 {
		t.Fatalf("expected all connections released, got %v", snapshot["total"])
	}
	if snapshot["ips"] != 0 {
		t.Fatalf("expected per-IP entries to be pruned, got %v", snapshot["ips"])
	}
}

func TestIsRealtimeEventClassification(t *testing.T) {
	for _, typ := range []string{"mouseMove", "mouseLeave", "box-selection"} {
		if !isRealtimeEvent(typ) {
			t.Fatalf("expected %q to be classified realtime", typ)
		}
	}
	for _, typ := range []string{"cmd-start", "cmd-update", "cmd-stop", "page-change"} {
		if isRealtimeEvent(typ) {
			t.Fatalf("expected %q to be classified reliable", typ)
		}
	}
}
