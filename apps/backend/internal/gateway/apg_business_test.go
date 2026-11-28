package gateway

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/apg"
	"collaborative-whiteboard/apps/backend/internal/auth"
)

func TestAPGSharedStateAuthorizationAndCAS(t *testing.T) {
	dir := t.TempDir()
	server, _ := newTestServerAtPathWithAPG(t, filepath.Join(dir, "room.sqlite"), dir)
	root := filepath.Join("..", "..", "..", "..", "plugins", "official", "shared-counter")
	path := filepath.Join(dir, "counter.apg")
	if err := apg.PackPackage(filepath.Join(root, "manifest.json"), path); err != nil {
		t.Fatal(err)
	}
	pkg, err := apg.ReadPackageBundle(path)
	if err != nil {
		t.Fatal(err)
	}
	url := "/api/apg/state/aevia.shared-counter?digest=" + pkg.Digest
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "apg-owner", "password": "password123"}, "")
	ownerToken := owner.Data["token"].(string)
	if code, _ := do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777123", "roomName": "APG"}, ownerToken); code != 200 {
		t.Fatalf("create: %d", code)
	}
	_, guest := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777123", "userName": "guest"}, "")
	token := guest.Data["sessionToken"].(string)
	claims, err := auth.NewTokenService("test-secret").Verify(token, "session")
	if err != nil {
		t.Fatal(err)
	}
	check := func(method, path string, body any, token string, want int) apiResponse {
		t.Helper()
		code, result := do(t, server, method, path, body, token)
		if code != want {
			t.Fatalf("%s %s: got %d want %d: %+v", method, path, code, want, result)
		}
		return result
	}
	check("GET", url, nil, "", 401)
	check("GET", url+"bad", nil, token, 403)
	check("GET", url, nil, token, 200)
	check("PUT", url, map[string]any{"revision": 0, "value": 1}, token, 200)
	check("PUT", url, map[string]any{"revision": 0, "value": 2}, token, 409)
	result := check("GET", url, nil, token, 200)
	if result.Data["revision"] != float64(1) || result.Data["value"] != float64(1) {
		t.Fatalf("state: %+v", result)
	}
	check("POST", "/v2/rooms/777123/guests/"+claims.UserID, map[string]any{"action": "viewer"}, ownerToken, 200)
	check("PUT", url, map[string]any{"revision": 1, "value": 3}, token, 403)
	check("GET", url, nil, token, 200)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	// A package the deployment removed loses both read and write authority on the next request;
	// there is no cached grant to wait out.
	check("GET", url, nil, token, 403)
	check("PUT", url, map[string]any{"revision": 1, "value": 4}, token, 403)
}

func TestAPGStateWritesAreBudgetedPerClient(t *testing.T) {
	dir := t.TempDir()
	server, _ := newTestServerAtPathWithAPG(t, filepath.Join(dir, "room.sqlite"), dir)
	root := filepath.Join("..", "..", "..", "..", "plugins", "official", "shared-counter")
	path := filepath.Join(dir, "counter.apg")
	if err := apg.PackPackage(filepath.Join(root, "manifest.json"), path); err != nil {
		t.Fatal(err)
	}
	pkg, err := apg.ReadPackageBundle(path)
	if err != nil {
		t.Fatal(err)
	}
	url := "/api/apg/state/aevia.shared-counter?digest=" + pkg.Digest
	_, owner := do(t, server, "POST", "/v2/auth/register", map[string]any{"username": "apg-budget", "password": "password123"}, "")
	token := owner.Data["token"].(string)
	if code, _ := do(t, server, "POST", "/v2/rooms", map[string]any{"roomId": "777124", "roomName": "APG"}, token); code != 200 {
		t.Fatalf("create: %d", code)
	}
	_, joined := do(t, server, "POST", "/join-room", map[string]any{"roomId": "777124"}, token)
	token = joined.Data["sessionToken"].(string)
	// The write budget is 12 with a 4/s refill: the first write succeeds and the
	// rest are conflicts, all of which are still counted, then the client is
	// throttled instead of letting a plugin hammer CAS and broadcasts.
	for i := 0; i < 12; i++ {
		want := 409
		if i == 0 {
			want = 200
		}
		if code, result := do(t, server, "PUT", url, map[string]any{"revision": 0, "value": i}, token); code != want {
			t.Fatalf("put %d: got %d want %d: %+v", i, code, want, result)
		}
	}
	code, result := do(t, server, "PUT", url, map[string]any{"revision": 1, "value": 99}, token)
	if code != http.StatusTooManyRequests {
		t.Fatalf("throttled put: got %d: %+v", code, result)
	}
}

func TestAPGArchivedResourceIsInert(t *testing.T) {
	dir := t.TempDir()
	server, _ := newTestServerAtPathWithAPG(t, filepath.Join(dir, "room.sqlite"), dir)
	root := filepath.Join("..", "..", "..", "..", "plugins", "official", "shape-template")
	source := filepath.Join(dir, "shape.apg")
	if err := apg.PackPackage(filepath.Join(root, "manifest.json"), source); err != nil {
		t.Fatal(err)
	}
	pkg, err := apg.ReadPackageBundle(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "archive"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(source, filepath.Join(dir, "archive", pkg.Digest+".apg")); err != nil {
		t.Fatal(err)
	}
	response, err := http.Get(server.URL + "/api/apg/asset/" + pkg.Digest + "/assets/card.json")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("X-Content-Type-Options") != "nosniff" || response.Header.Get("Content-Disposition") != "attachment" {
		t.Fatalf("asset: %d %+v", response.StatusCode, response.Header)
	}
}
