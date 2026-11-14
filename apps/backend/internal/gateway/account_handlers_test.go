package gateway

import (
	"net/http"
	"testing"
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
