package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/room"
	"collaborative-whiteboard/apps/backend/internal/storage"
)

// HTTP contract tests for the gateway. These replace the supertest suite that
// covered the retired Express backend, and additionally pin the auth and
// rate-limit behaviour that suite never exercised.

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	cfg := config.Config{
		DBPath:                 filepath.Join(t.TempDir(), "gateway.sqlite"),
		JWTSecret:              "test-secret",
		SessionTTL:             30 * time.Minute,
		InviteTTL:              time.Hour,
		RoomReliableQueue:      64,
		RoomRealtimeQueue:      64,
		ConnectionSendMessages: 64,
		DBBatchSize:            16,
		DBBatchWindow:          time.Millisecond,
		InitCommandChunkSize:   100,
		InitFlatPointChunkSize: 2000,
		MaxHTTPBodyBytes:       1 << 20,
		AllowedOrigins:         []string{"*"},
		HTTPRequestsPerSecond:  1000,
		HTTPRequestsBurst:      1000,
		AuthFailuresPerMinute:  60,
		AuthFailureBurst:       3,
		RateLimitIdleTTL:       time.Minute,
		RateLimitMaxKeys:       1000,
		MaxConnections:         100,
		MaxConnectionsPerIP:    100,
		MaxConnectionsPerRoom:  100,
		WALCheckpointInterval:  time.Hour,
		WALCheckpointBytes:     1 << 30,
		WALTruncateBytes:       1 << 31,
	}
	store, err := storage.Open(cfg)
	if err != nil {
		t.Fatalf("open storage: %v", err)
	}
	registry := room.NewRegistry(store, cfg)
	epoch, err := store.SessionEpoch(context.Background())
	if err != nil {
		t.Fatalf("session epoch: %v", err)
	}
	server := httptest.NewServer(NewServer(cfg, store, registry, epoch).Routes())
	t.Cleanup(func() {
		server.Close()
		registry.Shutdown(context.Background())
		_ = store.Close()
	})
	return server
}

type apiResponse struct {
	Code int            `json:"code"`
	Msg  string         `json:"msg"`
	Data map[string]any `json:"data"`
}

func do(t *testing.T, server *httptest.Server, method, path string, body any, token string) (int, apiResponse) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(payload)
	} else {
		reader = bytes.NewReader(nil)
	}
	request, err := http.NewRequest(method, server.URL+path, reader)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer response.Body.Close()
	var decoded apiResponse
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

func TestCreateAndJoinPasswordlessRoom(t *testing.T) {
	server := newTestServer(t)

	status, body := do(t, server, "POST", "/create-room", map[string]any{
		"roomId": "700001", "roomName": "Go Room",
	}, "")
	if status != http.StatusOK || body.Code != 200 {
		t.Fatalf("create-room: status=%d body=%+v", status, body)
	}

	status, body = do(t, server, "POST", "/join-room", map[string]any{
		"roomId": "700001", "userName": "Tester",
	}, "")
	if status != http.StatusOK {
		t.Fatalf("join-room: status=%d body=%+v", status, body)
	}
	if token, _ := body.Data["sessionToken"].(string); token == "" {
		t.Fatalf("expected a session token, got %+v", body.Data)
	}
	if expires, ok := body.Data["expiresAt"].(float64); !ok || expires <= 0 {
		t.Fatalf("expected a numeric expiresAt, got %+v", body.Data["expiresAt"])
	}
}

func TestGenerateRoomIDShape(t *testing.T) {
	server := newTestServer(t)

	status, body := do(t, server, "GET", "/generate-room-id", nil, "")
	if status != http.StatusOK {
		t.Fatalf("status=%d", status)
	}
	roomID, _ := body.Data["roomId"].(string)
	if !regexp.MustCompile(`^\d{6}$`).MatchString(roomID) {
		t.Fatalf("expected a six-digit room id, got %q", roomID)
	}
}

func TestProtectedRoutesRequireSession(t *testing.T) {
	server := newTestServer(t)

	for _, route := range []struct {
		method string
		path   string
	}{
		{"GET", "/generate-share-token?roomId=missing"},
		{"GET", "/get-page-review?roomId=missing"},
		{"POST", "/renew-room-session"},
	} {
		status, _ := do(t, server, route.method, route.path, nil, "")
		if status != http.StatusUnauthorized {
			t.Fatalf("%s %s: expected 401, got %d", route.method, route.path, status)
		}
		status, _ = do(t, server, route.method, route.path, nil, "not-a-token")
		if status != http.StatusUnauthorized {
			t.Fatalf("%s %s with a bad token: expected 401, got %d", route.method, route.path, status)
		}
	}
}

func TestPasswordProtectedRoomFlow(t *testing.T) {
	server := newTestServer(t)

	if status, _ := do(t, server, "POST", "/create-room", map[string]any{
		"roomId": "700002", "roomName": "Locked", "password": "s3cret",
	}, ""); status != http.StatusOK {
		t.Fatalf("create-room: status=%d", status)
	}

	if status, body := do(t, server, "POST", "/join-room", map[string]any{
		"roomId": "700002", "userName": "Tester", "password": "wrong",
	}, ""); status != http.StatusBadRequest || body.Msg != "Password incorrect" {
		t.Fatalf("expected a password rejection, got status=%d body=%+v", status, body)
	}

	status, body := do(t, server, "POST", "/join-room", map[string]any{
		"roomId": "700002", "userName": "Tester", "password": "s3cret",
	}, "")
	if status != http.StatusOK {
		t.Fatalf("join with the correct password: status=%d body=%+v", status, body)
	}
	token, _ := body.Data["sessionToken"].(string)

	// A valid session unlocks the protected routes.
	if status, _ := do(t, server, "GET", "/generate-share-token?roomId=700002", nil, token); status != http.StatusOK {
		t.Fatalf("generate-share-token with a session: status=%d", status)
	}
	if status, _ := do(t, server, "POST", "/renew-room-session", nil, token); status != http.StatusOK {
		t.Fatalf("renew-room-session: status=%d", status)
	}
}

func TestDuplicateRoomIsRejected(t *testing.T) {
	server := newTestServer(t)

	if status, _ := do(t, server, "POST", "/create-room", map[string]any{"roomId": "700003"}, ""); status != http.StatusOK {
		t.Fatal("first create should succeed")
	}
	status, body := do(t, server, "POST", "/create-room", map[string]any{"roomId": "700003"}, "")
	if status != http.StatusBadRequest || body.Msg != "Room already exists" {
		t.Fatalf("expected a duplicate rejection, got status=%d body=%+v", status, body)
	}
}

func TestCheckRoomReportsExistence(t *testing.T) {
	server := newTestServer(t)

	_, body := do(t, server, "GET", "/check-room?roomId=700004", nil, "")
	if exists, _ := body.Data["status"].(bool); exists {
		t.Fatal("expected an unknown room to report false")
	}
	do(t, server, "POST", "/create-room", map[string]any{"roomId": "700004"}, "")
	_, body = do(t, server, "GET", "/check-room?roomId=700004", nil, "")
	if exists, _ := body.Data["status"].(bool); !exists {
		t.Fatal("expected an existing room to report true")
	}
}

// Repeated wrong passwords are throttled; correct ones never are. This is the
// behaviour that keeps a shared NAT address from locking out honest users.
func TestOnlyFailedPasswordAttemptsAreThrottled(t *testing.T) {
	server := newTestServer(t)
	do(t, server, "POST", "/create-room", map[string]any{"roomId": "700005", "password": "pw"}, "")

	throttled := false
	for i := 0; i < 12; i++ {
		status, _ := do(t, server, "POST", "/join-room", map[string]any{
			"roomId": "700005", "userName": "Guesser", "password": "nope",
		}, "")
		if status == http.StatusTooManyRequests {
			throttled = true
			break
		}
	}
	if !throttled {
		t.Fatal("expected repeated wrong passwords to be throttled")
	}

	// Successful joins must not consume the failure budget at all.
	fresh := newTestServer(t)
	do(t, fresh, "POST", "/create-room", map[string]any{"roomId": "700006"}, "")
	for i := 0; i < 30; i++ {
		if status, _ := do(t, fresh, "POST", "/join-room", map[string]any{
			"roomId": "700006", "userName": "Honest",
		}, ""); status != http.StatusOK {
			t.Fatalf("successful join %d was rejected with %d", i, status)
		}
	}
}

func TestMetricsRequiresTokenOrLoopback(t *testing.T) {
	server := newTestServer(t)
	// httptest serves on loopback and METRICS_TOKEN is unset, so this is allowed.
	if status, _ := do(t, server, "GET", "/debug/metrics", nil, ""); status != http.StatusOK {
		t.Fatalf("expected loopback metrics access, got %d", status)
	}

	t.Setenv("METRICS_TOKEN", "secret")
	if status, _ := do(t, server, "GET", "/debug/metrics", nil, ""); status != http.StatusNotFound {
		t.Fatalf("expected 404 without the token, got %d", status)
	}
	if status, _ := do(t, server, "GET", "/debug/metrics", nil, "secret"); status != http.StatusOK {
		t.Fatalf("expected 200 with the token, got %d", status)
	}
}

func TestHealthEndpoints(t *testing.T) {
	server := newTestServer(t)
	for _, path := range []string{"/health/live", "/health/ready"} {
		if status, _ := do(t, server, "GET", path, nil, ""); status != http.StatusOK {
			t.Fatalf("%s: status=%d", path, status)
		}
	}
}

func TestInviteTokenRoundTrip(t *testing.T) {
	server := newTestServer(t)
	do(t, server, "POST", "/create-room", map[string]any{"roomId": "700007", "roomName": "Shared"}, "")
	_, join := do(t, server, "POST", "/join-room", map[string]any{"roomId": "700007", "userName": "Host"}, "")
	token, _ := join.Data["sessionToken"].(string)

	_, share := do(t, server, "GET", "/generate-share-token?roomId=700007", nil, token)
	invite, _ := share.Data["inviteToken"].(string)
	if invite == "" {
		t.Fatalf("expected an invite token, got %+v", share.Data)
	}

	status, info := do(t, server, "GET", "/get-token-info?token="+invite, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get-token-info: status=%d", status)
	}
	if info.Data["roomId"] != "700007" || info.Data["roomName"] != "Shared" {
		t.Fatalf("unexpected invite payload: %+v", info.Data)
	}
	if required, _ := info.Data["passwordRequired"].(bool); required {
		t.Fatal("a passwordless room must not report passwordRequired")
	}

	if status, _ := do(t, server, "GET", "/get-token-info?token=garbage", nil, ""); status != http.StatusBadRequest {
		t.Fatalf("expected a malformed invite token to be rejected, got %d", status)
	}
}
