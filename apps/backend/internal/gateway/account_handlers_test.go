package gateway

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/auth"
	"github.com/coder/websocket"
)

func TestWebsocketTicket(t *testing.T) {
	server := newTestServer(t)
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "ticketowner", "password": "password123"}, "")
	account := owner.Data["token"].(string)
	do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777009"}, account)
	status, joined := do(t, server, "POST", "/v2/rooms/777009/admission", map[string]any{}, account)
	if status != 200 {
		t.Fatalf("admission: %d %+v", status, joined)
	}
	grant := joined.Data["token"].(string)
	if status, _ = do(t, server, "POST", "/v2/rooms/other/ws-ticket", nil, grant); status != 403 {
		t.Fatalf("wrong room: %d", status)
	}
	status, issued := do(t, server, "POST", "/v2/rooms/777009/ws-ticket", nil, grant)
	if status != 200 {
		t.Fatalf("issue ticket: %d %+v", status, issued)
	}
	ticket := issued.Data["ticket"].(string)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := strings.Replace(server.URL, "http", "ws", 1) + "/ws"
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{ticket}})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()
	if _, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{ticket}}); err == nil {
		t.Fatal("ticket reused")
	}
	if _, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{grant}}); err == nil {
		t.Fatal("room grant accepted as ticket")
	}
}

func TestAccountSessionFlow(t *testing.T) {
	server := newTestServer(t)
	credentials := map[string]any{"username": "alice", "password": "password123", "nickname": "小艾"}
	status, registered := do(t, server, "POST", "/v2/auth/register", credentials, "")
	if status != http.StatusOK {
		t.Fatalf("register: %d %+v", status, registered)
	}
	first := registered.Data["token"].(string)
	status, refreshed := do(t, server, "POST", "/v2/auth/refresh", nil, first)
	if status != http.StatusOK {
		t.Fatalf("refresh: %d %+v", status, refreshed)
	}
	if status, _ = do(t, server, "POST", "/v2/auth/refresh", nil, first); status != http.StatusUnauthorized {
		t.Fatalf("old token refreshed: %d", status)
	}
	first = refreshed.Data["token"].(string)
	status, loggedIn := do(t, server, "POST", "/v2/auth/login", credentials, "")
	if status != http.StatusOK {
		t.Fatalf("login: %d %+v", status, loggedIn)
	}
	second := loggedIn.Data["token"].(string)
	status, profile := do(t, server, "PATCH", "/v2/auth/me", map[string]any{"nickname": "新昵称"}, first)
	if status != http.StatusOK || profile.Data["nickname"] != "新昵称" {
		t.Fatalf("nickname: %d %+v", status, profile)
	}
	do(t, server, "POST", "/v2/auth/logout", nil, first)
	if status, _ = do(t, server, "GET", "/v2/auth/me", nil, first); status != http.StatusUnauthorized {
		t.Fatalf("logged-out token accepted: %d", status)
	}
	if status, profile = do(t, server, "GET", "/v2/auth/me", nil, second); status != http.StatusOK || profile.Data["nickname"] != "新昵称" {
		t.Fatalf("other session: %d %+v", status, profile)
	}
}

func TestAccountRoomJoin(t *testing.T) {
	server := newTestServer(t)
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "owner", "password": "password123"}, "")
	token := owner.Data["token"].(string)
	status, created := do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777001", "roomName": "协作空间", "password": "secret"}, token)
	if status != http.StatusOK {
		t.Fatalf("create: %d %+v", status, created)
	}
	status, joined := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777001"}, token)
	if status != http.StatusOK || joined.Data["sessionToken"] == nil {
		t.Fatalf("owner join: %d %+v", status, joined)
	}
	status, _ = do(t, server, "POST", "/join-room", map[string]any{"roomId": "777001", "userName": "游客"}, "")
	if status == http.StatusOK {
		t.Fatal("guest joined a protected room without password")
	}
}

func TestRoomOwnerManagesMembers(t *testing.T) {
	server := newTestServer(t)
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "owner2", "password": "password123"}, "")
	ownerToken := owner.Data["token"].(string)
	do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777002", "roomName": "Room"}, ownerToken)
	_, member := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "member2", "password": "password123"}, "")
	memberToken := member.Data["token"].(string)
	memberID := member.Data["account"].(map[string]any)["id"].(string)
	do(t, server, "POST", "/join-room", map[string]any{"roomId": "777002"}, memberToken)
	path := "/v2/rooms/777002/members/" + memberID
	if status, _ := do(t, server, "PATCH", path, map[string]any{"role": "viewer"}, ownerToken); status != 200 {
		t.Fatalf("role change: %d", status)
	}
	if status, _ := do(t, server, "POST", path+"/ban", nil, ownerToken); status != 200 {
		t.Fatalf("ban: %d", status)
	}
	if status, _ := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777002"}, memberToken); status != 403 {
		t.Fatalf("banned member joined: %d", status)
	}
	if status, _ := do(t, server, "POST", path+"/unban", nil, ownerToken); status != 200 {
		t.Fatalf("unban: %d", status)
	}
	if status, _ := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777002"}, memberToken); status != 200 {
		t.Fatalf("unbanned member failed to rejoin: %d", status)
	}
}

func TestRevokedRoomSessionsCannotAccessRoomHTTP(t *testing.T) {
	server := newTestServer(t)
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "revocationowner", "password": "password123"}, "")
	ownerToken := owner.Data["token"].(string)
	do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777019", "roomName": "Room"}, ownerToken)
	_, member := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "revokedmember", "password": "password123"}, "")
	memberToken := member.Data["token"].(string)
	memberID := member.Data["account"].(map[string]any)["id"].(string)
	_, joined := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777019"}, memberToken)
	roomToken := joined.Data["sessionToken"].(string)
	if status, _ := do(t, server, "GET", "/get-page-review", nil, roomToken); status != http.StatusOK {
		t.Fatalf("member cannot access room before revocation: %d", status)
	}
	if status, _ := do(t, server, "POST", "/v2/rooms/777019/members/"+memberID+"/kick", nil, ownerToken); status != http.StatusOK {
		t.Fatalf("kick: %d", status)
	}
	for _, endpoint := range []struct{ method, path string }{{"GET", "/get-page-review"}, {"POST", "/renew-room-session"}} {
		if status, _ := do(t, server, endpoint.method, endpoint.path, nil, roomToken); status != http.StatusForbidden {
			t.Errorf("revoked session accessed %s: %d", endpoint.path, status)
		}
	}
	_, guest := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777019", "userName": "游客"}, "")
	guestToken := guest.Data["sessionToken"].(string)
	claims, err := auth.NewTokenService("test-secret").Verify(guestToken, "session")
	if err != nil {
		t.Fatal(err)
	}
	if status, _ := do(t, server, "POST", "/v2/rooms/777019/guests/"+claims.UserID, map[string]any{"action": "kick"}, ownerToken); status != http.StatusOK {
		t.Fatalf("kick guest: %d", status)
	}
	for _, endpoint := range []struct{ method, path string }{{"GET", "/get-page-review"}, {"POST", "/renew-room-session"}} {
		if status, _ := do(t, server, endpoint.method, endpoint.path, nil, guestToken); status != http.StatusForbidden {
			t.Errorf("revoked guest accessed %s: %d", endpoint.path, status)
		}
	}
}

func TestHistoryGroupCannotBeSharedAcrossUsers(t *testing.T) {
	server := newTestServer(t)
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "groupowner", "password": "password123"}, "")
	ownerToken := owner.Data["token"].(string)
	do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777020", "roomName": "Room"}, ownerToken)
	_, ownerJoin := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777020"}, ownerToken)
	ownerRoomToken := ownerJoin.Data["sessionToken"].(string)
	ownerClaims, err := auth.NewTokenService("test-secret").Verify(ownerRoomToken, "session")
	if err != nil {
		t.Fatal(err)
	}
	ownerConn := dialGatewayWebsocket(t, server, ownerRoomToken)
	defer ownerConn.Close(websocket.StatusNormalClosure, "")
	readGatewayWSType(t, ownerConn, "init-complete")
	writeGatewayWSJSON(t, ownerConn, testScenePush("owner-stroke", ownerClaims.UserID, "777020"))
	readGatewayWSType(t, ownerConn, "ack.accepted")
	_, guest := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777020", "userName": "游客"}, "")
	guestToken := guest.Data["sessionToken"].(string)
	guestClaims, err := auth.NewTokenService("test-secret").Verify(guestToken, "session")
	if err != nil {
		t.Fatal(err)
	}
	guestConn := dialGatewayWebsocket(t, server, guestToken)
	defer guestConn.Close(websocket.StatusNormalClosure, "")
	readGatewayWSType(t, guestConn, "init-complete")
	msg := testScenePush("guest-stroke", guestClaims.UserID, "777020")
	op := msg["data"].(map[string]any)["cmd"].(map[string]any)["sceneOperation"].(map[string]any)
	op["historyGroupId"] = "history-owner-stroke"
	writeGatewayWSJSON(t, guestConn, msg)
	result := readGatewayWSEnvelope(t, guestConn)
	if result.Type != "op-rejected" || result.Data["code"] != "FORBIDDEN" {
		t.Fatalf("cross-user history group accepted: type=%s data=%+v", result.Type, result.Data)
	}
}

func TestInviteCanBeRevoked(t *testing.T) {
	server := newTestServer(t)
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "inviter", "password": "password123"}, "")
	accountToken := owner.Data["token"].(string)
	do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777003", "roomName": "Room"}, accountToken)
	_, joined := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777003"}, accountToken)
	roomToken := joined.Data["sessionToken"].(string)
	_, issued := do(t, server, "GET", "/generate-share-token?roomId=777003&hours=1", nil, roomToken)
	invite := issued.Data["inviteToken"].(string)
	if status, _ := do(t, server, "GET", "/get-token-info?token="+invite, nil, ""); status != 200 {
		t.Fatalf("invite unavailable: %d", status)
	}
	// Extract the signed invitation's identifier as the server does when listing it.
	claims, err := auth.NewTokenService("test-secret").Verify(invite, "invite")
	if err != nil {
		t.Fatal(err)
	}
	if status, _ := do(t, server, "POST", "/room-invites/revoke", map[string]any{"id": claims.InviteID}, roomToken); status != 200 {
		t.Fatalf("revoke: %d", status)
	}
	if status, _ := do(t, server, "GET", "/get-token-info?token="+invite, nil, ""); status == 200 {
		t.Fatal("revoked invite accepted")
	}
}

func TestRoomTransferAndDelete(t *testing.T) {
	server := newTestServer(t)
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "firstowner", "password": "password123"}, "")
	ownerToken := owner.Data["token"].(string)
	do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777004", "roomName": "Transfer"}, ownerToken)
	_, member := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "nextowner", "password": "password123"}, "")
	memberToken := member.Data["token"].(string)
	id := member.Data["account"].(map[string]any)["id"].(string)
	do(t, server, "POST", "/join-room", map[string]any{"roomId": "777004"}, memberToken)
	if status, _ := do(t, server, "POST", "/v2/rooms/777004/transfer", map[string]any{"userId": id}, ownerToken); status != 200 {
		t.Fatalf("request transfer: %d", status)
	}
	if status, _ := do(t, server, "POST", "/v2/rooms/777004/transfer/respond", map[string]any{"accept": true}, memberToken); status != 200 {
		t.Fatalf("accept transfer: %d", status)
	}
	if status, _ := do(t, server, "DELETE", "/v2/rooms/777004", nil, ownerToken); status != 403 {
		t.Fatalf("old owner still controls room: %d", status)
	}
	if status, _ := do(t, server, "DELETE", "/v2/rooms/777004", nil, memberToken); status != 200 {
		t.Fatalf("delete: %d", status)
	}
	if status, _ := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777004", "userName": "Guest"}, ""); status == 200 {
		t.Fatal("deleted room is accessible")
	}
}

func TestGuestRequiresAccountToCreateRoom(t *testing.T) {
	server := newTestServer(t)
	response, err := http.Post(server.URL+"/create-room", "application/json", strings.NewReader(`{"roomId":"777005"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous room creation returned %d", response.StatusCode)
	}
}

func TestOwnerCanRemoveGuestSession(t *testing.T) {
	server := newTestServer(t)
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "guestowner", "password": "password123"}, "")
	accountToken := owner.Data["token"].(string)
	do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777006", "roomName": "Room"}, accountToken)
	_, guest := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777006", "userName": "游客"}, "")
	guestToken := guest.Data["sessionToken"].(string)
	claims, err := auth.NewTokenService("test-secret").Verify(guestToken, "session")
	if err != nil {
		t.Fatal(err)
	}
	path := "/v2/rooms/777006/guests/" + claims.UserID
	if status, _ := do(t, server, "POST", path, map[string]any{"action": "kick"}, accountToken); status != 200 {
		t.Fatalf("kick: %d", status)
	}
	if status, _ := do(t, server, "GET", "/generate-share-token?roomId=777006", nil, guestToken); status != 403 {
		t.Fatalf("removed guest can share: %d", status)
	}
	if status, _ := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777006", "userName": "游客"}, ""); status != 200 {
		t.Fatalf("guest cannot rejoin: %d", status)
	}
}

func TestGuestViewerCannotWrite(t *testing.T) {
	server := newTestServer(t)
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "readonlyowner", "password": "password123"}, "")
	ownerToken := owner.Data["token"].(string)
	do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777008", "roomName": "Room"}, ownerToken)
	_, guest := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777008", "userName": "游客"}, "")
	guestToken := guest.Data["sessionToken"].(string)
	claims, err := auth.NewTokenService("test-secret").Verify(guestToken, "session")
	if err != nil {
		t.Fatal(err)
	}
	conn := dialGatewayWebsocket(t, server, guestToken)
	defer conn.Close(websocket.StatusNormalClosure, "")
	readGatewayWSType(t, conn, "init-complete")
	if status, _ := do(t, server, "POST", "/v2/rooms/777008/guests/"+claims.UserID, map[string]any{"action": "viewer"}, ownerToken); status != 200 {
		t.Fatalf("set viewer: %d", status)
	}
	readGatewayWSType(t, conn, "role.changed")
	writeGatewayWSJSON(t, conn, testScenePush("viewer-stroke", claims.UserID, "777008"))
	if message := readGatewayWSType(t, conn, "op-rejected"); message.Data["code"] != "FORBIDDEN" {
		t.Fatalf("viewer write rejection: %+v", message.Data)
	}
}

func TestReconnectReceivesCurrentRoomRole(t *testing.T) {
	server := newTestServer(t)
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "rolesyncowner", "password": "password123"}, "")
	ownerToken := owner.Data["token"].(string)
	do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777030", "roomName": "Room"}, ownerToken)
	_, guest := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777030", "userName": "Guest"}, "")
	guestToken := guest.Data["sessionToken"].(string)
	claims, err := auth.NewTokenService("test-secret").Verify(guestToken, "session")
	if err != nil {
		t.Fatal(err)
	}
	path := "/v2/rooms/777030/guests/" + claims.UserID
	for _, role := range []string{"viewer", "editor"} {
		if status, _ := do(t, server, "POST", path, map[string]any{"action": role}, ownerToken); status != 200 {
			t.Fatalf("set %s: %d", role, status)
		}
		conn := dialGatewayWebsocket(t, server, guestToken)
		msg := readGatewayWSType(t, conn, "role.current")
		if msg.Data["role"] != role {
			t.Fatalf("got role %v, want %s", msg.Data["role"], role)
		}
		conn.Close(websocket.StatusNormalClosure, "")
	}
}

func TestAccountDeviceReplacement(t *testing.T) {
	server := newTestServer(t)
	_, account := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "multidevice", "password": "password123"}, "")
	token := account.Data["token"].(string)
	do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777007", "roomName": "Room"}, token)
	_, first := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777007"}, token)
	firstConn := dialGatewayWebsocket(t, server, first.Data["sessionToken"].(string))
	defer firstConn.Close(websocket.StatusNormalClosure, "")
	readGatewayWSType(t, firstConn, "init-complete")
	userID := account.Data["account"].(map[string]any)["id"].(string)
	writeGatewayWSJSON(t, firstConn, testScenePush("device-stroke", userID, "777007"))
	readGatewayWSType(t, firstConn, "ack.accepted")
	undo := testScenePush("history-device-before", userID, "777007")
	undoCmd := undo["data"].(map[string]any)["cmd"].(map[string]any)
	undoOp := undoCmd["sceneOperation"].(map[string]any)
	undoOp["kind"] = "history.toggle"
	undoOp["payload"] = map[string]any{"targetHistoryGroupId": "history-device-stroke", "enabled": false}
	writeGatewayWSJSON(t, firstConn, undo)
	readGatewayWSType(t, firstConn, "ack.accepted")
	_, second := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777007"}, token)
	secondConn := dialGatewayWebsocket(t, server, second.Data["sessionToken"].(string))
	defer secondConn.Close(websocket.StatusNormalClosure, "")
	readGatewayWSType(t, firstConn, "session.replaced")
	readGatewayWSType(t, secondConn, "init-complete")
	for index, enabled := range []bool{true, false, true} {
		id := fmt.Sprintf("history-device-%d", index)
		msg := testScenePush(id, userID, "777007")
		cmd := msg["data"].(map[string]any)["cmd"].(map[string]any)
		op := cmd["sceneOperation"].(map[string]any)
		op["kind"] = "history.toggle"
		op["payload"] = map[string]any{"targetHistoryGroupId": "history-device-stroke", "enabled": enabled}
		writeGatewayWSJSON(t, secondConn, msg)
		readGatewayWSType(t, secondConn, "ack.accepted")
	}
}
