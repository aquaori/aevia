package gateway

import (
	"errors"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/auth"
)

func newSessionTokenTestServer(epoch int64) *Server {
	return &Server{tokens: auth.NewTokenService("test-secret"), sessionEpoch: epoch}
}

func TestVerifySessionTokenAcceptsCurrentSessions(t *testing.T) {
	epoch := time.Now().Add(-time.Minute).Unix()
	server := newSessionTokenTestServer(epoch)
	token, _, err := server.tokens.Sign(auth.Claims{
		UserID: "user-1", UserName: "Ann", RoomID: "room-1", TokenType: "session",
	}, time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	claims, err := server.verifySessionToken(token)
	if err != nil {
		t.Fatalf("expected a valid session token, got %v", err)
	}
	if claims.UserID != "user-1" || claims.UserName != "Ann" || claims.RoomID != "room-1" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestVerifySessionTokenRejectsTokensBeforeTheEpoch(t *testing.T) {
	// A session epoch in the future is exactly the "token predates the persisted
	// epoch" case that logs clients out after a password/session bump.
	server := newSessionTokenTestServer(time.Now().Add(time.Hour).Unix())
	token, _, err := server.tokens.Sign(auth.Claims{
		UserID: "user-1", RoomID: "room-1", TokenType: "session",
	}, time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	claims, err := server.verifySessionToken(token)
	if !errors.Is(err, errStaleSessionToken) {
		t.Fatalf("expected errStaleSessionToken, got %v", err)
	}
	if claims.UserID != "" {
		t.Fatalf("a stale token must not leak claims, got %+v", claims)
	}
}

func TestVerifySessionTokenRejectsWrongTypeAndTampering(t *testing.T) {
	server := newSessionTokenTestServer(0)

	invite, _, err := server.tokens.Sign(auth.Claims{
		RoomID: "room-1", TokenType: "invite",
	}, time.Minute)
	if err != nil {
		t.Fatalf("sign invite: %v", err)
	}
	if _, err := server.verifySessionToken(invite); err == nil {
		t.Fatal("expected an invite token to be rejected as a session token")
	}

	session, _, err := server.tokens.Sign(auth.Claims{
		UserID: "user-1", RoomID: "room-1", TokenType: "session",
	}, time.Minute)
	if err != nil {
		t.Fatalf("sign session: %v", err)
	}
	if _, err := server.verifySessionToken(session + "tampered"); err == nil {
		t.Fatal("expected a tampered signature to be rejected")
	}
	if _, err := server.verifySessionToken("not-a-token"); err == nil {
		t.Fatal("expected a malformed token to be rejected")
	}

	// A token signed with a different secret must not verify.
	foreign, _, err := auth.NewTokenService("other-secret").Sign(auth.Claims{
		UserID: "user-1", RoomID: "room-1", TokenType: "session",
	}, time.Minute)
	if err != nil {
		t.Fatalf("sign foreign: %v", err)
	}
	if _, err := server.verifySessionToken(foreign); err == nil {
		t.Fatal("expected a token from another secret to be rejected")
	}
}

func TestVerifySessionTokenRejectsExpiredTokens(t *testing.T) {
	server := newSessionTokenTestServer(0)
	expired, _, err := server.tokens.Sign(auth.Claims{
		UserID: "user-1", RoomID: "room-1", TokenType: "session",
	}, -time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := server.verifySessionToken(expired); err == nil {
		t.Fatal("expected an expired session token to be rejected")
	}
}
