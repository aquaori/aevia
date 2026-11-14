package gateway

import (
	"net/http"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/auth"
)

func TestAccountSessionFlow(t *testing.T) {
	server := newTestServer(t)
	credentials := map[string]any{"username": "alice", "password": "password123", "nickname": "小艾"}
	status, registered := do(t, server, "POST", "/v2/auth/register", credentials, "")
	if status != http.StatusOK {
		t.Fatalf("register: %d %+v", status, registered)
	}
	first := registered.Data["token"].(string)
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
