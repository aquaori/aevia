package gateway

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/auth"
	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/domain"
	"collaborative-whiteboard/apps/backend/internal/protocol"
	"collaborative-whiteboard/apps/backend/internal/room"
	"collaborative-whiteboard/apps/backend/internal/storage"
)

func registerTestAccount(t *testing.T, server *httptest.Server, username string) (string, string) {
	t.Helper()
	status, body := do(t, server, "POST", "/v2/auth/register", map[string]any{
		"username": username,
		"password": "password123",
		"nickname": username,
	}, "")
	if status != http.StatusOK {
		t.Fatalf("register %s: %d %+v", username, status, body)
	}
	token, _ := body.Data["token"].(string)
	account, _ := body.Data["account"].(map[string]any)
	id, _ := account["id"].(string)
	return token, id
}

func TestGatewayRoomInvitesSettingsMembersTransferAndPageReview(t *testing.T) {
	server := newTestServer(t)

	ownerToken, _ := registerTestAccount(t, server, "gwowner")
	memberToken, memberID := registerTestAccount(t, server, "gwmember")
	targetToken, targetID := registerTestAccount(t, server, "gwtarget")

	// Unauthenticated listAccountRooms returns 401
	if st, _ := do(t, server, "GET", "/v2/rooms", nil, ""); st != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauth /v2/rooms, got %d", st)
	}

	// Owner creates room via v2 endpoint
	if st, body := do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "880001"}, ownerToken); st != http.StatusOK {
		t.Fatalf("create account room: %d %+v", st, body)
	}
	if st, body := do(t, server, "GET", "/v2/rooms", nil, ownerToken); st != http.StatusOK {
		t.Fatalf("list account rooms: %d %+v", st, body)
	}

	// Owner admission -> room session token -> generate share token -> list invites -> revoke -> page review
	st, adm := do(t, server, "POST", "/v2/rooms/880001/admission", map[string]any{}, ownerToken)
	if st != http.StatusOK {
		t.Fatalf("owner admission: %d %+v", st, adm)
	}
	ownerGrant, _ := adm.Data["token"].(string)

	if st, _ := do(t, server, "GET", "/generate-share-token?roomId=880001", nil, ownerGrant); st != http.StatusOK {
		t.Fatalf("generate share token: %d", st)
	}
	if st, _ := do(t, server, "GET", "/room-invites", nil, ownerGrant); st != http.StatusOK {
		t.Fatalf("list invites: %d", st)
	}
	if st, _ := do(t, server, "POST", "/room-invites/revoke", map[string]any{}, ownerGrant); st != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty invite revoke, got %d", st)
	}
	if st, body := do(t, server, "GET", "/get-page-review", nil, ownerGrant); st != http.StatusOK || body.Code != 200 {
		t.Fatalf("get page review: %d %+v", st, body)
	}

	// Room settings get & patch
	if st, _ := do(t, server, "GET", "/v2/rooms/880001/settings", nil, ownerGrant); st != http.StatusForbidden && st != http.StatusOK {
		// Note: settings endpoint authenticates using account session token (roomAccount).
	}
	if st, _ := do(t, server, "GET", "/v2/rooms/880001/settings", nil, ownerToken); st != http.StatusOK {
		t.Fatalf("get settings: %d", st)
	}
	if st, _ := do(t, server, "PATCH", "/v2/rooms/880001/settings", map[string]any{
		"name":            "",
		"policy":          map[string]any{"defaultRole": "invalid"},
		"setPassword":     false,
		"requirePassword": false,
	}, ownerToken); st != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid settings, got %d", st)
	}
	if st, _ := do(t, server, "PATCH", "/v2/rooms/880001/settings", map[string]any{
		"name":            "Updated Room",
		"password":        "roompass",
		"setPassword":     true,
		"requirePassword": true,
		"policy":          map[string]any{"defaultRole": "editor", "allowRoomCode": true, "guestByCode": true, "guestByInvite": true},
	}, ownerToken); st != http.StatusOK {
		t.Fatalf("patch settings: %d", st)
	}

	// Member & Target join room
	if st, _ := do(t, server, "POST", "/v2/rooms/880001/admission", map[string]any{"password": "roompass"}, memberToken); st != http.StatusOK {
		t.Fatalf("member admission: %d", st)
	}
	if st, _ := do(t, server, "POST", "/v2/rooms/880001/admission", map[string]any{"password": "roompass"}, targetToken); st != http.StatusOK {
		t.Fatalf("target admission: %d", st)
	}

	// Members & audit & role/kick/ban/unban & leave
	if st, _ := do(t, server, "GET", "/v2/rooms/880001/members", nil, memberToken); st != http.StatusOK {
		t.Fatalf("room members: %d", st)
	}
	if st, _ := do(t, server, "GET", "/v2/rooms/880001/member-audit", nil, ownerToken); st != http.StatusOK {
		t.Fatalf("member audit: %d", st)
	}
	if st, _ := do(t, server, "PATCH", "/v2/rooms/880001/members/"+memberID, map[string]any{"role": "viewer"}, ownerToken); st != http.StatusOK {
		t.Fatalf("change member role: %d", st)
	}
	if st, _ := do(t, server, "POST", "/v2/rooms/880001/leave", nil, ownerToken); st != http.StatusBadRequest {
		t.Fatalf("expected owner leave to fail before transfer, got %d", st)
	}
	if st, _ := do(t, server, "POST", "/v2/rooms/880001/leave", nil, memberToken); st != http.StatusOK {
		t.Fatalf("member leave: %d", st)
	}
	if st, _ := do(t, server, "POST", "/v2/rooms/880001/members/"+targetID+"/ban", nil, ownerToken); st != http.StatusOK {
		t.Fatalf("ban member: %d", st)
	}
	if st, _ := do(t, server, "POST", "/v2/rooms/880001/members/"+targetID+"/unban", nil, ownerToken); st != http.StatusOK {
		t.Fatalf("unban member: %d", st)
	}

	// Re-join target and exercise transfer + accept + deleteRoom
	if st, _ := do(t, server, "POST", "/v2/rooms/880001/admission", map[string]any{"password": "roompass"}, targetToken); st != http.StatusOK {
		t.Fatalf("target rejoin: %d", st)
	}
	if st, _ := do(t, server, "POST", "/v2/rooms/880001/transfer", map[string]any{"userId": targetID}, ownerToken); st != http.StatusOK {
		t.Fatalf("request transfer: %d", st)
	}
	if st, _ := do(t, server, "GET", "/v2/transfers", nil, targetToken); st != http.StatusOK {
		t.Fatalf("pending transfers: %d", st)
	}
	if st, _ := do(t, server, "POST", "/v2/rooms/880001/transfer/respond", map[string]any{"accept": true}, targetToken); st != http.StatusOK {
		t.Fatalf("accept transfer: %d", st)
	}
	if st, _ := do(t, server, "DELETE", "/v2/rooms/880001", nil, targetToken); st != http.StatusOK {
		t.Fatalf("delete room by new owner: %d", st)
	}

	// Account validation error cases
	if st, _ := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "gwowner", "password": "password123"}, ""); st != http.StatusConflict && st != http.StatusBadRequest {
		t.Fatalf("expected duplicate register rejection, got %d", st)
	}
	if st, _ := do(t, server, "POST", "/v2/auth/login", map[string]any{"username": "gwowner", "password": "wrongpassword"}, ""); st != http.StatusUnauthorized {
		t.Fatalf("expected wrong password login 401, got %d", st)
	}
	if st, _ := do(t, server, "PATCH", "/v2/auth/me", map[string]any{"nickname": ""}, ownerToken); st != http.StatusBadRequest {
		t.Fatalf("expected empty nickname 400, got %d", st)
	}
	if st, _ := do(t, server, "POST", "/v2/auth/logout", nil, ""); st != http.StatusOK && st != http.StatusUnauthorized {
		t.Fatalf("logout without token unexpected status: %d", st)
	}
}

func TestGatewayHealthReadyAndBeginDraining(t *testing.T) {
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	cfg.DBPath = filepath.Join(t.TempDir(), "health.sqlite")
	cfg.JWTSecret = "secret"
	cfg.RateLimitIdleTTL = time.Minute
	store, err := storage.Open(cfg)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	registry := room.NewRegistry(store, cfg)
	srv := NewServer(cfg, store, registry, 0)
	ts := httptest.NewServer(srv.Routes())
	defer func() {
		ts.Close()
		registry.Shutdown(context.Background())
		_ = store.Close()
	}()

	if st, _ := do(t, ts, "GET", "/health/live", nil, ""); st != http.StatusOK {
		t.Fatalf("live: %d", st)
	}
	if st, _ := do(t, ts, "GET", "/health/ready", nil, ""); st != http.StatusOK {
		t.Fatalf("ready: %d", st)
	}
	srv.BeginDraining()
	if st, _ := do(t, ts, "GET", "/health/ready", nil, ""); st != http.StatusServiceUnavailable {
		t.Fatalf("ready while draining: %d", st)
	}
}

func readEnvelopeType(t *testing.T, ch <-chan room.Outbound, wantType string) room.Envelope {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		select {
		case item := <-ch:
			if env, ok := item.JSON.(room.Envelope); ok && env.Type == wantType {
				return env
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q", wantType)
		}
	}
}

func TestWSMessageHandlersAndRejections(t *testing.T) {
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	cfg.DBPath = filepath.Join(t.TempDir(), "wsmsg.sqlite")
	cfg.JWTSecret = "secret"
	cfg.WSMaxPointsPerUpdate = 2
	cfg.WSMaxPointsPerCommand = 10
	cfg.WSMaxBatchCommands = 2
	store, err := storage.Open(cfg)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer store.Close()
	ctx := context.Background()
	_ = store.CreateRoom(ctx, domain.Room{RoomID: "ws-room", Name: "WS"})
	registry := room.NewRegistry(store, cfg)
	defer registry.Shutdown(ctx)
	actor, err := registry.Get(ctx, "ws-room")
	if err != nil {
		t.Fatalf("get actor: %v", err)
	}

	viewerClient := newWSClient(nil, actor, auth.Claims{UserID: "u-view", UserName: "View", RoomID: "ws-room", Role: "viewer"}, 0, cfg)
	_, _ = actor.Join(room.ClientInfo{ID: viewerClient.id, UserID: "u-view", UserName: "View", PageID: 0, Send: viewerClient.send}, 0, 0)
	defer actor.Leave(viewerClient.id)

	// Viewer cannot emit push-cmd (text or binary)
	pushPayload, _ := json.Marshal(map[string]any{"type": "push-cmd", "data": map[string]any{"cmd": map[string]any{"id": "c1"}}})
	handleTextClientMessage(viewerClient, pushPayload)
	msg := readEnvelopeType(t, viewerClient.send, "op-rejected")
	if msg.Data["code"] != "FORBIDDEN" {
		t.Fatalf("expected FORBIDDEN op-rejected, got %+v", msg)
	}

	// Malformed scene append magic binary frame triggers INVALID_SCENE_OPERATION
	badMagic := make([]byte, 8)
	binary.BigEndian.PutUint32(badMagic[:4], protocol.SceneAppendMagic)
	handleBinaryClientMessage(viewerClient, badMagic)
	msg = readEnvelopeType(t, viewerClient.send, "op-rejected")
	if msg.Data["code"] != "INVALID_SCENE_OPERATION" {
		t.Fatalf("expected INVALID_SCENE_OPERATION, got %+v", msg)
	}

	// Editor client with oversized binary cmd-update hits PAYLOAD_LIMIT_EXCEEDED
	editorClient := newWSClient(nil, actor, auth.Claims{UserID: "u-edit", UserName: "Edit", RoomID: "ws-room", Role: "editor"}, 0, cfg)
	_, _ = actor.Join(room.ClientInfo{ID: editorClient.id, UserID: "u-edit", UserName: "Edit", PageID: 0, Send: editorClient.send}, 0, 0)
	defer actor.Leave(editorClient.id)

	overFrame := protocol.EncodeCommandUpdatePoints("c-over", []domain.Point{{X: 1}, {X: 2}, {X: 3}})
	handleBinaryClientMessage(editorClient, overFrame)
	msg = readEnvelopeType(t, editorClient.send, "op-rejected")
	if msg.Data["code"] != "PAYLOAD_LIMIT_EXCEEDED" {
		t.Fatalf("expected PAYLOAD_LIMIT_EXCEEDED, got %+v", msg)
	}

	// Text page-change triggers actor.PageChange
	pageChangePayload, _ := json.Marshal(map[string]any{
		"type": "page-change",
		"data": map[string]any{"requestId": 1, "prevPageId": 0, "nextPageId": 0, "pageId": 0, "clientLoadedPageIds": []int{0}},
	})
	handleTextClientMessage(editorClient, pageChangePayload)

	// Invalid JSON ignored safely
	handleTextClientMessage(editorClient, []byte("not-json"))
	handleBinaryClientMessage(editorClient, []byte{0, 1, 2})

	if rejectedCommandID(map[string]any{"cmd": map[string]any{"id": "c-x"}}) != "c-x" {
		t.Fatal("expected cmd.id from rejectedCommandID")
	}
	if rejectedCommandID(map[string]any{"cmdId": "c-y"}) != "c-y" {
		t.Fatal("expected cmdId fallback from rejectedCommandID")
	}
}
