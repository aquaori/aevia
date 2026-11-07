package gateway

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/auth"
)

func TestCreateRoomValidation(t *testing.T) {
	server := newTestServer(t)

	status, body := do(t, server, "POST", "/create-room", map[string]any{"roomName": "No id"}, "")
	if status != http.StatusBadRequest || body.Msg != "Room ID is required" {
		t.Fatalf("expected a missing room id to be rejected, got status=%d body=%+v", status, body)
	}

	// A room created without a name still gets a generated one.
	if status, _ := do(t, server, "POST", "/create-room", map[string]any{"roomId": "720001"}, ""); status != http.StatusOK {
		t.Fatalf("expected room creation without a name to succeed, got %d", status)
	}
	if status, _ := do(t, server, "GET", "/check-room?roomId=720001", nil, ""); status != http.StatusOK {
		t.Fatalf("expected the created room to be checkable, got %d", status)
	}
	if status, body := do(t, server, "GET", "/check-room", nil, ""); status != http.StatusBadRequest || body.Msg != "Room ID is required" {
		t.Fatalf("expected check-room to require a room id, got status=%d body=%+v", status, body)
	}
}

func TestJoinRoomValidation(t *testing.T) {
	server := newTestServer(t)

	if status, body := do(t, server, "POST", "/join-room", map[string]any{"userName": "Ann"}, ""); status != http.StatusBadRequest || body.Msg != "Room ID is required" {
		t.Fatalf("expected a missing room id to be rejected, got status=%d body=%+v", status, body)
	}
	if status, body := do(t, server, "POST", "/join-room", map[string]any{"roomId": "720002"}, ""); status != http.StatusBadRequest || body.Msg != "User Name is required" {
		t.Fatalf("expected a missing user name to be rejected, got status=%d body=%+v", status, body)
	}
	if status, body := do(t, server, "POST", "/join-room", map[string]any{"roomId": "720002", "userName": "Ann"}, ""); status != http.StatusBadRequest || body.Msg != "Room does not exist" {
		t.Fatalf("expected an unknown room to be rejected, got status=%d body=%+v", status, body)
	}
}

func TestGenerateShareTokenRejectsMismatchedRoom(t *testing.T) {
	server := newTestServer(t)
	do(t, server, "POST", "/create-room", map[string]any{"roomId": "720003"}, "")

	_, join := do(t, server, "POST", "/join-room", map[string]any{"roomId": "720003", "userName": "Ann"}, "")
	token, _ := join.Data["sessionToken"].(string)
	if token == "" {
		t.Fatalf("expected a session token, got %+v", join.Data)
	}

	status, body := do(t, server, "GET", "/generate-share-token?roomId=720004", nil, token)
	if status != http.StatusForbidden || body.Msg != "Token room does not match request room" {
		t.Fatalf("expected a cross-room invite request to be rejected, got status=%d body=%+v", status, body)
	}
}

func TestGenerateShareTokenForUnknownRoom(t *testing.T) {
	server := newTestServer(t)
	// A structurally valid session token for a room that does not exist: the
	// signature check passes, so the handler must fail on the room lookup.
	token, _, err := auth.NewTokenService("test-secret").Sign(auth.Claims{
		UserID: "user-1", UserName: "Ann", RoomID: "720005", TokenType: "session",
	}, time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	status, body := do(t, server, "GET", "/generate-share-token?roomId=720005", nil, token)
	if status != http.StatusBadRequest || body.Msg != "Room does not exist" {
		t.Fatalf("expected a missing room to be rejected, got status=%d body=%+v", status, body)
	}
}

func TestRenewSessionRejectsForgedRoomIdentity(t *testing.T) {
	server := newTestServer(t)
	do(t, server, "POST", "/create-room", map[string]any{"roomId": "720006"}, "")

	// Valid signature and token type, but the embedded room creation timestamp
	// does not match the stored room: the session must not be renewed.
	token, _, err := auth.NewTokenService("test-secret").Sign(auth.Claims{
		UserID: "user-1", UserName: "Ann", RoomID: "720006", RoomCreatedAt: 1, TokenType: "session",
	}, time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	status, body := do(t, server, "POST", "/renew-room-session", nil, token)
	if status != http.StatusUnauthorized || body.Msg != "Room session is no longer valid" {
		t.Fatalf("expected a forged room identity to be rejected, got status=%d body=%+v", status, body)
	}
}

func TestGetTokenInfoValidation(t *testing.T) {
	server := newTestServer(t)

	if status, body := do(t, server, "GET", "/get-token-info", nil, ""); status != http.StatusBadRequest || body.Msg != "Token required" {
		t.Fatalf("expected a missing token to be rejected, got status=%d body=%+v", status, body)
	}

	// An invite token for a room that was never created must not resolve.
	missingRoom, _, err := auth.NewTokenService("test-secret").Sign(auth.Claims{
		RoomID: "720007", RoomCreatedAt: 1, TokenType: "invite",
	}, time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if status, body := do(t, server, "GET", "/get-token-info?token="+missingRoom, nil, ""); status != http.StatusBadRequest || body.Msg != "Room does not exist" {
		t.Fatalf("expected a missing room to be rejected, got status=%d body=%+v", status, body)
	}
}

func TestIsUniqueConstraintErrorClassification(t *testing.T) {
	if isUniqueConstraintError(nil) {
		t.Fatal("nil must not be classified as a unique violation")
	}
	for _, message := range []string{
		"UNIQUE constraint failed: rooms.room_id",
		"constraint failed: UNIQUE (room_id)",
	} {
		if !isUniqueConstraintError(errors.New(message)) {
			t.Fatalf("expected %q to be classified as a unique violation", message)
		}
	}
	if isUniqueConstraintError(errors.New("disk I/O error")) {
		t.Fatal("an unrelated storage failure must not be classified as a duplicate room")
	}
}
