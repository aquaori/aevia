package auth

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestSignVerifyRoundTrip(t *testing.T) {
	service := NewTokenService("test-secret")
	claims := Claims{UserID: "u1", UserName: "alice", RoomID: "123123", RoomCreatedAt: 42, TokenType: "session"}

	token, expiresAt, err := service.Sign(claims, time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if expiresAt <= 0 {
		t.Fatalf("expected positive expiry, got %d", expiresAt)
	}

	got, err := service.Verify(token, "session")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got.UserID != "u1" || got.UserName != "alice" || got.RoomID != "123123" {
		t.Fatalf("claims round-trip mismatch: %+v", got)
	}
	if got.Iat == 0 || got.Exp <= got.Iat {
		t.Fatalf("expected iat/exp to be populated, got iat=%d exp=%d", got.Iat, got.Exp)
	}
}

func TestVerifyRejectsWrongSecret(t *testing.T) {
	token, _, err := NewTokenService("secret-a").Sign(Claims{TokenType: "session"}, time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := NewTokenService("secret-b").Verify(token, "session"); err == nil {
		t.Fatal("expected verification against a different secret to fail")
	}
}

func TestVerifyRejectsWrongTokenType(t *testing.T) {
	service := NewTokenService("test-secret")
	token, _, err := service.Sign(Claims{TokenType: "invite"}, time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := service.Verify(token, "session"); err == nil {
		t.Fatal("expected an invite token to be rejected as a session token")
	}
}

func TestVerifyRejectsExpiredToken(t *testing.T) {
	service := NewTokenService("test-secret")
	token, _, err := service.Sign(Claims{TokenType: "session"}, -time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := service.Verify(token, "session"); err == nil {
		t.Fatal("expected an expired token to be rejected")
	}
}

// TestVerifyRejectsUnsignedToken covers the "alg: none" shape: a well-formed
// header and payload with no valid signature must not be accepted.
func TestVerifyRejectsUnsignedToken(t *testing.T) {
	header, _ := json.Marshal(map[string]string{"alg": "none", "typ": "JWT"})
	payload, _ := json.Marshal(Claims{TokenType: "session", Exp: time.Now().Add(time.Hour).Unix()})
	forged := strings.Join([]string{
		base64.RawURLEncoding.EncodeToString(header),
		base64.RawURLEncoding.EncodeToString(payload),
		"",
	}, ".")

	if _, err := NewTokenService("test-secret").Verify(forged, "session"); err == nil {
		t.Fatal("expected an unsigned token to be rejected")
	}
}

func TestVerifyRejectsTamperedPayload(t *testing.T) {
	service := NewTokenService("test-secret")
	token, _, err := service.Sign(Claims{RoomID: "room-a", TokenType: "session"}, time.Minute)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	parts := strings.Split(token, ".")
	tampered, _ := json.Marshal(Claims{RoomID: "room-b", TokenType: "session", Exp: time.Now().Add(time.Hour).Unix()})
	parts[1] = base64.RawURLEncoding.EncodeToString(tampered)

	if _, err := service.Verify(strings.Join(parts, "."), "session"); err == nil {
		t.Fatal("expected a tampered payload to fail signature verification")
	}
}

func TestVerifyRejectsMalformedToken(t *testing.T) {
	service := NewTokenService("test-secret")
	for _, token := range []string{"", "a", "a.b", "a.b.c.d", "...."} {
		if _, err := service.Verify(token, "session"); err == nil {
			t.Fatalf("expected malformed token %q to be rejected", token)
		}
	}
}
