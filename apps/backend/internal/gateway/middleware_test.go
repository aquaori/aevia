package gateway

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
)

func middlewareTestConfig(origins []string) config.Config {
	return config.Config{
		AllowedOrigins:        origins,
		HTTPRequestsPerSecond: 1,
		HTTPRequestsBurst:     1,
		AuthFailuresPerMinute: 1,
		AuthFailureBurst:      1,
		RateLimitIdleTTL:      time.Minute,
		RateLimitMaxKeys:      100,
		MaxHTTPBodyBytes:      1 << 20,
	}
}

func TestWithCORSAllowsConfiguredOrigin(t *testing.T) {
	server := NewServer(middlewareTestConfig([]string{"https://app.example"}), nil, nil, 0)
	nextCalled := false
	handler := server.withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusOK)
	}))

	request := httptest.NewRequest("GET", "/create-room", nil)
	request.Header.Set("Origin", "https://app.example")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if !nextCalled || recorder.Code != http.StatusOK {
		t.Fatalf("expected the wrapped handler to run, called=%v status=%d", nextCalled, recorder.Code)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Fatalf("expected the request origin to be echoed, got %q", got)
	}
	if got := recorder.Header().Values("Vary"); len(got) != 1 || got[0] != "Origin" {
		t.Fatalf("expected a single Vary: Origin header, got %v", got)
	}
	allowHeaders := recorder.Header().Get("Access-Control-Allow-Headers")
	for _, header := range []string{"Authorization", "Content-Type", "Sec-WebSocket-Protocol"} {
		if !strings.Contains(allowHeaders, header) {
			t.Fatalf("expected %q in allow-headers, got %q", header, allowHeaders)
		}
	}
	if got := recorder.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "OPTIONS") {
		t.Fatalf("expected OPTIONS in allow-methods, got %q", got)
	}
}

func TestWithCORSRejectsDisallowedOriginBeforeNext(t *testing.T) {
	server := NewServer(middlewareTestConfig([]string{"https://app.example"}), nil, nil, 0)
	nextCalled := false
	handler := server.withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
	}))

	request := httptest.NewRequest("GET", "/create-room", nil)
	request.Header.Set("Origin", "https://evil.example")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if nextCalled {
		t.Fatal("a disallowed origin must not reach the wrapped handler")
	}
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("a rejected origin must not receive CORS headers, got %q", got)
	}
	if !strings.Contains(recorder.Body.String(), "Origin is not allowed") {
		t.Fatalf("unexpected rejection body: %s", recorder.Body.String())
	}
}

func TestWithCORSHandlesPreflight(t *testing.T) {
	server := NewServer(middlewareTestConfig([]string{"https://app.example"}), nil, nil, 0)
	nextCalled := false
	handler := server.withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
	}))

	request := httptest.NewRequest("OPTIONS", "/join-room", nil)
	request.Header.Set("Origin", "https://app.example")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if nextCalled {
		t.Fatal("preflight must be answered by the CORS middleware")
	}
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", recorder.Code)
	}

	// A disallowed origin must not even receive a successful preflight.
	badRequest := httptest.NewRequest("OPTIONS", "/join-room", nil)
	badRequest.Header.Set("Origin", "https://evil.example")
	badRecorder := httptest.NewRecorder()
	handler.ServeHTTP(badRecorder, badRequest)
	if badRecorder.Code != http.StatusForbidden {
		t.Fatalf("expected a rejected preflight to return 403, got %d", badRecorder.Code)
	}
}

func TestWithCORSWildcardSkipsVary(t *testing.T) {
	server := NewServer(middlewareTestConfig([]string{"*"}), nil, nil, 0)
	handler := server.withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	request := httptest.NewRequest("GET", "/health/live", nil)
	request.Header.Set("Origin", "https://anywhere.example")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("expected a wildcard CORS origin, got %q", got)
	}
	if got := recorder.Header().Values("Vary"); len(got) != 0 {
		t.Fatalf("a wildcard response must not vary by origin, got %v", got)
	}

	// Without an Origin header the wildcard is still advertised.
	plainRecorder := httptest.NewRecorder()
	handler.ServeHTTP(plainRecorder, httptest.NewRequest("GET", "/health/live", nil))
	if got := plainRecorder.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("expected the wildcard without an Origin header, got %q", got)
	}
}

func TestLimitBodyEnforcesByteCeiling(t *testing.T) {
	var readErr error
	handler := limitBody(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, readErr = io.ReadAll(r.Body)
	}), 4)

	request := httptest.NewRequest("POST", "/join-room", strings.NewReader("12345"))
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if readErr == nil {
		t.Fatal("expected an oversized body to fail while reading")
	}
	var maxBytesError *http.MaxBytesError
	if !errors.As(readErr, &maxBytesError) {
		t.Fatalf("expected http.MaxBytesError, got %T: %v", readErr, readErr)
	}

	withinLimit := httptest.NewRequest("POST", "/join-room", strings.NewReader("1234"))
	withinLimitRecorder := httptest.NewRecorder()
	handler.ServeHTTP(withinLimitRecorder, withinLimit)
	if readErr != nil {
		t.Fatalf("expected a body at the limit to be readable, got %v", readErr)
	}
}

func TestLimitHTTPRateAppliesToAPIButNotHealth(t *testing.T) {
	server := NewServer(middlewareTestConfig([]string{"*"}), nil, nil, 0)
	nextCalls := 0
	handler := server.limitHTTPRate(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalls++
		w.WriteHeader(http.StatusOK)
	}))

	request := httptest.NewRequest("GET", "/check-room?roomId=1", nil)
	request.RemoteAddr = "203.0.113.5:1234"
	first := httptest.NewRecorder()
	handler.ServeHTTP(first, request)
	if first.Code != http.StatusOK || nextCalls != 1 {
		t.Fatalf("expected the first API call through, status=%d calls=%d", first.Code, nextCalls)
	}

	exhausted := httptest.NewRecorder()
	handler.ServeHTTP(exhausted, request)
	if exhausted.Code != http.StatusTooManyRequests {
		t.Fatalf("expected the exhausted bucket to return 429, got %d", exhausted.Code)
	}
	if nextCalls != 1 {
		t.Fatal("a rate-limited request must not reach the handler")
	}

	// Health probes are exempt: a throttled client must still be able to detect
	// that the process is alive.
	for _, path := range []string{"/health/live", "/health/ready"} {
		healthRequest := httptest.NewRequest("GET", path, nil)
		healthRequest.RemoteAddr = "203.0.113.5:1234"
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, healthRequest)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: expected health to bypass the limiter, got %d", path, recorder.Code)
		}
	}
}

func TestLimitHTTPRateRejectsExhaustedJoinAttempts(t *testing.T) {
	server := NewServer(middlewareTestConfig([]string{"*"}), nil, nil, 0)
	nextCalls := 0
	handler := server.limitHTTPRate(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalls++
		w.WriteHeader(http.StatusOK)
	}))

	const clientIP = "198.51.100.7"
	// Spend the failure budget the way notePasswordFailure does.
	server.authLimiter.Allow(clientIP)
	server.authLimiter.Allow(clientIP)

	joinRequest := httptest.NewRequest("POST", "/join-room", nil)
	joinRequest.RemoteAddr = clientIP + ":5555"
	joinRecorder := httptest.NewRecorder()
	handler.ServeHTTP(joinRecorder, joinRequest)
	if joinRecorder.Code != http.StatusTooManyRequests || nextCalls != 0 {
		t.Fatalf("expected the join to be throttled, status=%d calls=%d", joinRecorder.Code, nextCalls)
	}

	// Other endpoints are not gated on the password-failure budget: an
	// exhausted password limit must not block room creation. A distinct client
	// IP is used so the request-volume limiter has its own bucket.
	createRequest := httptest.NewRequest("POST", "/create-room", nil)
	createRequest.RemoteAddr = "198.51.100.8:5555"
	createRecorder := httptest.NewRecorder()
	handler.ServeHTTP(createRecorder, createRequest)
	if createRecorder.Code != http.StatusOK || nextCalls != 1 {
		t.Fatalf("expected create-room to stay open, status=%d calls=%d", createRecorder.Code, nextCalls)
	}
}
