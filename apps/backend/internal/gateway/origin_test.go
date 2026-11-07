package gateway

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestOriginAllowed(t *testing.T) {
	tests := []struct {
		name    string
		allowed []string
		origin  string
		want    bool
	}{
		{"without an origin header everything is allowed", []string{"https://app.example"}, "", true},
		{"an exact match is allowed", []string{"https://app.example"}, "https://app.example", true},
		{"matching is case-insensitive", []string{"https://App.Example"}, "https://app.example", true},
		{"a wildcard allows any origin", []string{"*"}, "https://anywhere.example", true},
		{"an unlisted origin is denied", []string{"https://app.example"}, "https://evil.example", false},
		{"an empty allowlist denies real origins", nil, "https://app.example", false},
		{"an empty allowlist still allows non-browser clients", nil, "", true},
		{"one matching entry in a list is enough", []string{"https://a.example", "https://b.example"}, "https://b.example", true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := NewServer(middlewareTestConfig(test.allowed), nil, nil, 0)
			request := httptest.NewRequest("GET", "/", nil)
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if got := server.originAllowed(request); got != test.want {
				t.Fatalf("expected %v, got %v", test.want, got)
			}
		})
	}
}

func TestWSOriginPatterns(t *testing.T) {
	wildcard := NewServer(middlewareTestConfig([]string{"*", "https://app.example"}), nil, nil, 0)
	if got := wildcard.wsOriginPatterns(); !reflect.DeepEqual(got, []string{"*"}) {
		t.Fatalf("expected a wildcard pattern list, got %v", got)
	}

	explicit := NewServer(middlewareTestConfig([]string{"https://a.example", "https://b.example"}), nil, nil, 0)
	want := []string{"https://a.example", "https://b.example"}
	if got := explicit.wsOriginPatterns(); !reflect.DeepEqual(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}

	empty := NewServer(middlewareTestConfig(nil), nil, nil, 0)
	if got := empty.wsOriginPatterns(); len(got) != 0 {
		t.Fatalf("expected no patterns for an empty allowlist, got %v", got)
	}
}

func TestCorsOrigin(t *testing.T) {
	wildcard := NewServer(middlewareTestConfig([]string{"*"}), nil, nil, 0)
	request := httptest.NewRequest("GET", "/", nil)
	request.Header.Set("Origin", "https://anywhere.example")
	if got := wildcard.corsOrigin(request); got != "*" {
		t.Fatalf("expected a wildcard CORS origin, got %q", got)
	}

	explicit := NewServer(middlewareTestConfig([]string{"https://app.example"}), nil, nil, 0)
	allowed := httptest.NewRequest("GET", "/", nil)
	allowed.Header.Set("Origin", "https://app.example")
	if got := explicit.corsOrigin(allowed); got != "https://app.example" {
		t.Fatalf("expected the request origin to be echoed, got %q", got)
	}

	denied := httptest.NewRequest("GET", "/", nil)
	denied.Header.Set("Origin", "https://evil.example")
	if got := explicit.corsOrigin(denied); got != "" {
		t.Fatalf("expected no CORS origin for a denied request, got %q", got)
	}

	// Non-browser callers have no Origin to echo, even with an allowlist.
	anonymous := httptest.NewRequest("GET", "/", nil)
	if got := explicit.corsOrigin(anonymous); got != "" {
		t.Fatalf("expected no CORS origin without an Origin header, got %q", got)
	}
}

func TestOriginChecksUseHeadersNotTheRequestPath(t *testing.T) {
	server := NewServer(middlewareTestConfig([]string{"https://app.example"}), nil, nil, 0)

	// A disallowed origin is denied on the WebSocket upgrade path too: the same
	// predicate backs HTTP CORS and the WebSocket origin patterns.
	upgrade := httptest.NewRequest(http.MethodGet, "/ws", nil)
	upgrade.Header.Set("Origin", "https://evil.example")
	upgrade.Header.Set("Connection", "Upgrade")
	upgrade.Header.Set("Upgrade", "websocket")
	if server.originAllowed(upgrade) {
		t.Fatal("expected a disallowed WebSocket origin to be rejected")
	}

	allowedUpgrade := httptest.NewRequest(http.MethodGet, "/ws", nil)
	allowedUpgrade.Header.Set("Origin", "https://app.example")
	if !server.originAllowed(allowedUpgrade) {
		t.Fatal("expected an allowed WebSocket origin to pass")
	}
}
