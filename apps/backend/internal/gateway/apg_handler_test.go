package gateway

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/config"
)

func writeAPGForGateway(t *testing.T, path string, manifest map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(w).Encode(manifest); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestAPGCatalogEndpointReloadsAndFailsClosed(t *testing.T) {
	dir := t.TempDir()
	server := NewServer(config.Config{
		APGDir:                dir,
		APGTrustPolicy:        "allow-unsigned",
		MaxHTTPBodyBytes:      1 << 20,
		AllowedOrigins:        []string{"*"},
		HTTPRequestsPerSecond: 100,
		HTTPRequestsBurst:     100,
		RateLimitIdleTTL:      60_000_000_000,
		RateLimitMaxKeys:      100,
	}, nil, nil, 0)
	handler := server.Routes()

	request := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/apg/catalog", nil)
		req.RemoteAddr = "127.0.0.1:1234"
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		return res
	}

	res := request()
	if res.Code != http.StatusOK || !bytes.Contains(res.Body.Bytes(), []byte(`"plugins":[]`)) {
		t.Fatalf("empty catalog: status=%d body=%s", res.Code, res.Body.String())
	}

	manifest := map[string]any{
		"manifestVersion": 1,
		"id":              "acme.palette",
		"name":            "Palette",
		"version":         "1.0.0",
		"scope":           "user",
		"contributes": map[string]any{
			"palettes": []any{map[string]any{"id": "brand", "label": "Brand", "colors": []string{"#AABBCC"}}},
		},
	}
	writeAPGForGateway(t, filepath.Join(dir, "palette.apg"), manifest)
	res = request()
	if res.Code != http.StatusOK || !bytes.Contains(res.Body.Bytes(), []byte(`"id":"acme.palette"`)) {
		t.Fatalf("loaded catalog: status=%d body=%s", res.Code, res.Body.String())
	}

	if err := os.WriteFile(filepath.Join(dir, "broken.apg"), []byte("bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	res = request()
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("invalid catalog should fail closed: status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestAPGPublicEndpointsBudgetEachClient(t *testing.T) {
	// The test spends more tickets than a production global budget, so the global
	// HTTP limiter stays out of the way and only the APG budgets act.
	server := NewServer(config.Config{
		APGDir:                t.TempDir(),
		APGTrustPolicy:        "allow-unsigned",
		MaxHTTPBodyBytes:      1 << 20,
		AllowedOrigins:        []string{"*"},
		HTTPRequestsPerSecond: 1000,
		HTTPRequestsBurst:     1000,
		RateLimitIdleTTL:      60_000_000_000,
		RateLimitMaxKeys:      100,
	}, nil, nil, 0)
	handler := server.Routes()

	call := func(path, addr string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = addr
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		return res
	}

	// The catalog burst is 40: the client that spends it is refused, and the
	// refusal tells it when to come back instead of failing as a server error.
	for i := 0; i < 40; i++ {
		if res := call("/api/apg/catalog", "127.0.0.1:1234"); res.Code != http.StatusOK {
			t.Fatalf("catalog request %d: status=%d body=%s", i, res.Code, res.Body.String())
		}
	}
	res := call("/api/apg/catalog", "127.0.0.1:1234")
	if res.Code != http.StatusTooManyRequests || res.Header().Get("Retry-After") != "1" {
		t.Fatalf("throttled catalog: status=%d retry=%q", res.Code, res.Header().Get("Retry-After"))
	}
	// Another client has its own budget, so one noisy browser cannot lock the
	// deployment's catalog away from everyone else.
	if res := call("/api/apg/catalog", "127.0.0.2:9999"); res.Code != http.StatusOK {
		t.Fatalf("second client catalog: status=%d body=%s", res.Code, res.Body.String())
	}

	// Assets keep a separate, larger budget. A missing digest is a 404 until the
	// budget is spent, then a 429 — rate limiting is not an existence oracle.
	for i := 0; i < 120; i++ {
		if res := call("/api/apg/asset/"+strings.Repeat("a", 64)+"/assets/card.json", "127.0.0.1:1234"); res.Code != http.StatusNotFound {
			t.Fatalf("asset request %d: status=%d body=%s", i, res.Code, res.Body.String())
		}
	}
	res = call("/api/apg/asset/"+strings.Repeat("a", 64)+"/assets/card.json", "127.0.0.1:1234")
	if res.Code != http.StatusTooManyRequests {
		t.Fatalf("throttled asset: status=%d body=%s", res.Code, res.Body.String())
	}
}
