package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsAuthorizedAllowsLoopbackOnlyWithoutToken(t *testing.T) {
	t.Setenv("METRICS_TOKEN", "")
	server := &Server{}

	loopback := httptest.NewRequest("GET", "/debug/metrics", nil)
	loopback.RemoteAddr = "127.0.0.1:1234"
	if !server.metricsAuthorized(loopback) {
		t.Fatal("expected loopback access without a token")
	}

	outside := httptest.NewRequest("GET", "/debug/metrics", nil)
	outside.RemoteAddr = "203.0.113.9:1234"
	if server.metricsAuthorized(outside) {
		t.Fatal("expected non-loopback access to be denied without a token")
	}

	// The denial is a 404: the endpoint should not advertise its existence.
	recorder := httptest.NewRecorder()
	server.metrics(recorder, outside)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "Not found") {
		t.Fatalf("unexpected denial body: %s", recorder.Body.String())
	}
}

func TestMetricsAuthorizedTokenPrecedence(t *testing.T) {
	t.Setenv("METRICS_TOKEN", "secret")
	server := &Server{}

	tests := []struct {
		name   string
		path   string
		header string
		want   bool
	}{
		{name: "wrong bearer token", path: "/debug/metrics", header: "Bearer nope", want: false},
		{name: "correct bearer token", path: "/debug/metrics", header: "Bearer secret", want: true},
		{name: "correct query token", path: "/debug/metrics?token=secret", want: true},
		{name: "wrong query token", path: "/debug/metrics?token=nope", want: false},
		{name: "bearer takes precedence over a correct query token", path: "/debug/metrics?token=secret", header: "Bearer nope", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", test.path, nil)
			request.RemoteAddr = "203.0.113.9:1234"
			if test.header != "" {
				request.Header.Set("Authorization", test.header)
			}
			if got := server.metricsAuthorized(request); got != test.want {
				t.Fatalf("expected %v, got %v", test.want, got)
			}
		})
	}
}

func TestMetricsEndpointPayload(t *testing.T) {
	t.Setenv("METRICS_TOKEN", "")
	server := newTestServer(t)

	status, body := do(t, server, "GET", "/debug/metrics", nil, "")
	if status != http.StatusOK || body.Code != 200 {
		t.Fatalf("expected 200, got status=%d body=%+v", status, body)
	}
	for _, key := range []string{"status", "connections", "limiters", "storage", "rooms"} {
		if _, ok := body.Data[key]; !ok {
			t.Fatalf("expected %q in the metrics payload, got %+v", key, body.Data)
		}
	}
	statusData, ok := body.Data["status"].(map[string]any)
	if !ok {
		t.Fatalf("expected a status object, got %T", body.Data["status"])
	}
	if draining, _ := statusData["draining"].(bool); draining {
		t.Fatal("a fresh server must not report itself as draining")
	}
	if epoch, _ := statusData["epoch"].(float64); epoch <= 0 {
		t.Fatalf("expected a positive persisted session epoch, got %v", statusData["epoch"])
	}
	limiters, ok := body.Data["limiters"].(map[string]any)
	if !ok {
		t.Fatalf("expected a limiters object, got %T", body.Data["limiters"])
	}
	if _, ok := limiters["httpKeys"]; !ok {
		t.Fatalf("expected http limiter key counts, got %+v", limiters)
	}
	storageData, ok := body.Data["storage"].(map[string]any)
	if !ok {
		t.Fatalf("expected a storage object, got %T", body.Data["storage"])
	}
	if _, ok := storageData["writer"]; !ok {
		t.Fatalf("expected writer metrics, got %+v", storageData)
	}
}

func TestMetricsDenialDoesNotLeakPayload(t *testing.T) {
	t.Setenv("METRICS_TOKEN", "secret")
	server := newTestServer(t)

	status, body := do(t, server, "GET", "/debug/metrics", nil, "wrong")
	if status != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", status)
	}
	if body.Data != nil {
		t.Fatalf("a denied metrics request must not return data, got %+v", body.Data)
	}
	if body.Msg != "Not found" {
		t.Fatalf("unexpected denial message: %q", body.Msg)
	}
}
