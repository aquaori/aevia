package gateway

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/protocol"
	"collaborative-whiteboard/apps/backend/internal/room"
	"collaborative-whiteboard/apps/backend/internal/storage"
	"github.com/coder/websocket"
)

// HTTP contract tests for the gateway. These replace the supertest suite that
// covered the retired Express backend, and additionally pin the auth and
// rate-limit behaviour that suite never exercised.

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	server, _ := newTestServerAtPath(t, filepath.Join(t.TempDir(), "gateway.sqlite"))
	return server
}

func newTestServerAtPath(t *testing.T, dbPath string) (*httptest.Server, func()) {
	t.Helper()
	handler, closeGateway := newTestGatewayAtPath(t, dbPath)
	server := httptest.NewServer(handler)
	closeServer := func() {
		server.Close()
		closeGateway()
	}
	t.Cleanup(closeServer)
	return server, closeServer
}

func newTestGatewayAtPath(t *testing.T, dbPath string) (http.Handler, func()) {
	t.Helper()
	cfg := config.Config{
		DBPath:                 dbPath,
		JWTSecret:              "test-secret",
		SessionTTL:             30 * time.Minute,
		InviteTTL:              time.Hour,
		RoomReliableQueue:      64,
		RoomRealtimeQueue:      64,
		ConnectionSendMessages: 64,
		WSMaxPayloadBytes:      256 * 1024,
		WSMaxPointsPerCommand:  20000,
		WSMaxPointsPerUpdate:   2000,
		WSMaxBatchCommands:     200,
		WSRealtimePerSecond:    90,
		WSRealtimeBurst:        180,
		WSReliablePerSecond:    120,
		WSReliableBurst:        240,
		WSHeartbeatInterval:    25 * time.Second,
		WSPongTimeout:          10 * time.Second,
		DBBatchSize:            16,
		DBBatchWindow:          time.Millisecond,
		InitPreloadPageCount:   2,
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
	handler := NewServer(cfg, store, registry, epoch).Routes()
	closed := false
	closeGateway := func() {
		if closed {
			return
		}
		closed = true
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		registry.Shutdown(ctx)
		if err := store.Close(); err != nil {
			t.Errorf("close test storage: %v", err)
		}
	}
	t.Cleanup(closeGateway)
	return handler, closeGateway
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

type gatewayWSEnvelope struct {
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
}

func dialGatewayWebsocket(t *testing.T, server *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "http", "ws", 1)+"/ws?pageId=0", &websocket.DialOptions{
		Subprotocols: []string{token},
	})
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	return conn
}

func readGatewayWSEnvelope(t *testing.T, conn *websocket.Conn) gatewayWSEnvelope {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		messageType, payload, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read websocket: %v", err)
		}
		if messageType != websocket.MessageText {
			continue
		}
		var message gatewayWSEnvelope
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatalf("decode websocket message: %v", err)
		}
		return message
	}
}

func readGatewayWSType(t *testing.T, conn *websocket.Conn, expected string) gatewayWSEnvelope {
	t.Helper()
	for {
		message := readGatewayWSEnvelope(t, conn)
		if message.Type == "op-rejected" && expected != "op-rejected" {
			t.Fatalf("unexpected websocket rejection while waiting for %s: %+v", expected, message.Data)
		}
		if message.Type == expected {
			return message
		}
	}
}

func testScenePush(opID, actorID, roomID string) map[string]any {
	operation := map[string]any{
		"schemaVersion":  float64(2),
		"opId":           opID,
		"elementId":      "element-" + opID,
		"actorId":        actorID,
		"roomId":         roomID,
		"pageId":         float64(0),
		"lamport":        float64(1),
		"historyGroupId": "history-" + opID,
		"kind":           "element.create",
		"payload": map[string]any{
			"descriptor": map[string]any{
				"elementKind": "path",
				"toolId":      "pen",
				"recipeId":    "stroke",
				"style": map[string]any{
					"color":         "#112233",
					"size":          float64(4),
					"strokePattern": "solid",
				},
			},
			"points": []any{map[string]any{
				"x": float64(0.1), "y": float64(0.2), "p": float64(0.5), "lamport": float64(1),
			}},
			"isComplete": true,
		},
	}
	return map[string]any{
		"type": "push-cmd",
		"data": map[string]any{
			"cmd": map[string]any{
				"id": opID, "type": "scene-op", "schemaVersion": float64(2),
				"userId": actorID, "roomId": roomID, "pageId": float64(0), "lamport": float64(1),
				"sceneOperation": operation,
			},
		},
	}
}

func writeGatewayWSJSON(t *testing.T, conn *websocket.Conn, message any) {
	t.Helper()
	payload, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("marshal websocket message: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("write websocket message: %v", err)
	}
}

func readGatewayInitCommandIDs(t *testing.T, conn *websocket.Conn) []string {
	t.Helper()
	var commandIDs []string
	for {
		message := readGatewayWSEnvelope(t, conn)
		if message.Type == "init-commands-chunk" {
			commands, _ := message.Data["commands"].([]any)
			for _, raw := range commands {
				command, _ := raw.(map[string]any)
				if id, _ := command["id"].(string); id != "" {
					commandIDs = append(commandIDs, id)
				}
			}
		}
		if message.Type == "init-complete" {
			return commandIDs
		}
	}
}

func TestWebsocketSceneWriteSurvivesGatewayRestart(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "restart.sqlite")
	server, stopServer := newTestServerAtPath(t, dbPath)
	const roomID = "700008"
	if status, _ := do(t, server, "POST", "/create-room", map[string]any{"roomId": roomID, "roomName": "Restart"}, ""); status != http.StatusOK {
		t.Fatalf("create room: status=%d", status)
	}
	_, joined := do(t, server, "POST", "/join-room", map[string]any{"roomId": roomID, "userName": "Writer"}, "")
	token, _ := joined.Data["sessionToken"].(string)
	if token == "" {
		t.Fatalf("join response omitted the session token: %+v", joined.Data)
	}

	client := dialGatewayWebsocket(t, server, token)
	meta := readGatewayWSType(t, client, "init-meta")
	userID, _ := meta.Data["userId"].(string)
	if userID == "" {
		t.Fatal("init-meta omitted the trusted user id")
	}
	readGatewayWSType(t, client, "init-complete")

	writeGatewayWSJSON(t, client, testScenePush("forged-op", "another-user", roomID))
	rejected := readGatewayWSType(t, client, "op-rejected")
	if rejected.Data["code"] != "INVALID_SCENE_OPERATION" {
		t.Fatalf("expected a forged identity to be rejected, got %+v", rejected.Data)
	}

	writeGatewayWSJSON(t, client, testScenePush("persisted-op", userID, roomID))
	ack := readGatewayWSType(t, client, "ack.accepted")
	if ack.Data["cmdId"] != "persisted-op" {
		t.Fatalf("ack did not identify the accepted operation: %+v", ack.Data)
	}
	roomSeq, ok := ack.Data["roomSeq"].(float64)
	if !ok || roomSeq <= 0 {
		t.Fatalf("ack omitted the durable room sequence: %+v", ack.Data)
	}
	if err := client.Close(websocket.StatusNormalClosure, "restart test"); err != nil {
		t.Fatalf("close first websocket: %v", err)
	}
	stopServer()

	restarted, _ := newTestServerAtPath(t, dbPath)
	rejoined := dialGatewayWebsocket(t, restarted, token)
	restartMeta := readGatewayWSType(t, rejoined, "init-meta")
	if restartMeta.Data["userId"] != userID {
		t.Fatalf("session identity changed across restart: before=%v after=%v", userID, restartMeta.Data["userId"])
	}
	if snapshotVersion, ok := restartMeta.Data["snapshotVersion"].(float64); !ok || snapshotVersion != roomSeq {
		t.Fatalf("restart snapshot version did not recover the committed sequence: got %v want %v", restartMeta.Data["snapshotVersion"], roomSeq)
	}
	readGatewayInitCommandIDs(t, rejoined)
	writeGatewayWSJSON(t, rejoined, testScenePush("persisted-op", userID, roomID))
	retryAck := readGatewayWSType(t, rejoined, "ack.accepted")
	if retryAck.Data["roomSeq"] != roomSeq {
		t.Fatalf("retry changed sequence: got %v want %v", retryAck.Data["roomSeq"], roomSeq)
	}
	conflict := testScenePush("persisted-op", userID, roomID)
	conflictCommand := conflict["data"].(map[string]any)["cmd"].(map[string]any)
	conflictCommand["sceneOperation"].(map[string]any)["lamport"] = float64(2)
	conflictCommand["lamport"] = float64(2)
	writeGatewayWSJSON(t, rejoined, conflict)
	if rejected := readGatewayWSType(t, rejoined, "op-rejected"); rejected.Data["code"] != "DUPLICATE_OPERATION" {
		t.Fatalf("expected conflicting duplicate rejection, got %+v", rejected.Data)
	}
	if err := rejoined.Close(websocket.StatusNormalClosure, "session restored"); err != nil {
		t.Fatalf("close restored session websocket: %v", err)
	}

	status, laterJoin := do(t, restarted, "POST", "/join-room", map[string]any{"roomId": roomID, "userName": "Later reader"}, "")
	if status != http.StatusOK {
		t.Fatalf("later join: status=%d response=%+v", status, laterJoin)
	}
	laterToken, _ := laterJoin.Data["sessionToken"].(string)
	if laterToken == "" {
		t.Fatalf("later join response omitted the session token: %+v", laterJoin.Data)
	}
	laterClient := dialGatewayWebsocket(t, restarted, laterToken)
	defer laterClient.Close(websocket.StatusNormalClosure, "test complete")
	laterMeta := readGatewayWSType(t, laterClient, "init-meta")
	if laterMeta.Data["userId"] == userID {
		t.Fatalf("later join reused the original session identity: %v", userID)
	}
	commandIDs := readGatewayInitCommandIDs(t, laterClient)
	var persisted, forged bool
	for _, id := range commandIDs {
		persisted = persisted || id == "persisted-op"
		forged = forged || id == "forged-op"
	}
	if !persisted || forged {
		t.Fatalf("later join snapshot commands persisted=%v forged=%v ids=%v chunkSummary=%v", persisted, forged, commandIDs, laterMeta.Data["chunkSummary"])
	}
}

func TestWebsocketSceneAppendBinaryUsesNormalWritePath(t *testing.T) {
	server := newTestServer(t)
	const roomID = "700009"
	do(t, server, "POST", "/create-room", map[string]any{"roomId": roomID, "roomName": "Binary"}, "")
	_, joined := do(t, server, "POST", "/join-room", map[string]any{"roomId": roomID, "userName": "Writer"}, "")
	client := dialGatewayWebsocket(t, server, joined.Data["sessionToken"].(string))
	defer client.Close(websocket.StatusNormalClosure, "done")
	meta := readGatewayWSType(t, client, "init-meta")
	userID := meta.Data["userId"].(string)
	readGatewayWSType(t, client, "init-complete")
	message := testScenePush("binary-op", userID, roomID)
	data := message["data"].(map[string]any)
	op := data["cmd"].(map[string]any)["sceneOperation"].(map[string]any)
	op["kind"] = "element.append"
	op["payload"] = map[string]any{"sourceStart": 0, "points": []any{}, "isComplete": true}
	metadata, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	frame := make([]byte, 12+len(metadata)+32)
	binary.BigEndian.PutUint32(frame, protocol.SceneAppendMagic)
	binary.BigEndian.PutUint32(frame[4:], uint32(len(metadata)))
	binary.BigEndian.PutUint32(frame[8:], 1)
	copy(frame[12:], metadata)
	for i, value := range []float64{0.125, 0.25, 0.5, 1} {
		binary.BigEndian.PutUint64(frame[12+len(metadata)+8*i:], math.Float64bits(value))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Write(ctx, websocket.MessageBinary, frame); err != nil {
		t.Fatal(err)
	}
	if ack := readGatewayWSType(t, client, "ack.accepted"); ack.Data["opId"] != "binary-op" {
		t.Fatalf("unexpected ack: %+v", ack.Data)
	}
	writeGatewayWSJSON(t, client, message)
	if rejection := readGatewayWSType(t, client, "op-rejected"); rejection.Data["code"] != "DUPLICATE_OPERATION" {
		t.Fatalf("expected conflicting operation rejection: %+v", rejection.Data)
	}
}
