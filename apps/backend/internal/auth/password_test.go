package auth

import (
	"strings"
	"testing"
)

func TestHashPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct horse")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if !strings.HasPrefix(hash, argonPrefix+"$") {
		t.Fatalf("expected argon2id hash, got %q", hash)
	}
	if strings.Contains(hash, "correct horse") {
		t.Fatal("hash must not contain the plaintext password")
	}
	if !VerifyPassword("correct horse", hash) {
		t.Fatal("expected the correct password to verify")
	}
	if VerifyPassword("wrong horse", hash) {
		t.Fatal("expected an incorrect password to be rejected")
	}
}

func TestHashPasswordUsesDistinctSalts(t *testing.T) {
	first, err := HashPassword("same")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	second, err := HashPassword("same")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if first == second {
		t.Fatal("expected per-hash salts to produce different digests")
	}
}

func TestVerifyPasswordEmptyStored(t *testing.T) {
	if !VerifyPassword("", "") {
		t.Fatal("a room with no password should accept an empty password")
	}
	if VerifyPassword("anything", "") {
		t.Fatal("a room with no password should reject a non-empty password")
	}
}

// TestVerifyPasswordLegacyScrypt keeps compatibility with rows written before the
// switch to argon2id.
func TestVerifyPasswordLegacyScrypt(t *testing.T) {
	stored := legacyScryptHash(t, "legacy-secret")
	if !VerifyPassword("legacy-secret", stored) {
		t.Fatal("expected a legacy scrypt hash to verify")
	}
	if VerifyPassword("nope", stored) {
		t.Fatal("expected a wrong password against a legacy hash to fail")
	}
}

func TestVerifyPasswordRejectsCorruptHash(t *testing.T) {
	for _, stored := range []string{
		argonPrefix + "$m=1,t=1,p=1$zzzz$zzzz",
		scryptPrefix + "$nothex$nothex",
	} {
		if VerifyPassword("whatever", stored) {
			t.Fatalf("expected corrupt hash %q to fail verification", stored)
		}
	}
}
