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
