package auth

import (
	"testing"
	"time"
)

func TestConfigureHashPoolAndTimeout(t *testing.T) {
	t.Cleanup(func() {
		ConfigureHashPool(2, 1500*time.Millisecond)
	})

	ConfigureHashPool(0, 10*time.Millisecond)
	if cap(hashPool) != 1 {
		t.Fatalf("expected pool size clamped to 1, got %d", cap(hashPool))
	}
	hashPool <- struct{}{}
	defer func() { <-hashPool }()

	if _, err := HashPassword("blocked"); err == nil {
		t.Fatal("expected HashPassword to fail when pool is saturated past timeout")
	}
	if VerifyPassword("blocked", "argon2id$m=32768,t=1,p=1$00$00") {
		t.Fatal("expected VerifyPassword to return false on pool timeout")
	}
}

func TestVerifyPasswordInvalidFormats(t *testing.T) {
	if VerifyPassword("pw", "argon2id$m=32768,t=1,p=1$zz$00") {
		t.Fatal("expected invalid argon2 hex salt to return false")
	}
	if VerifyPassword("pw", "argon2id$m=32768,t=1,p=1$0011$zz") {
		t.Fatal("expected invalid argon2 hex key to return false")
	}
	if VerifyPassword("pw", "scrypt$zz$00") {
		t.Fatal("expected invalid scrypt salt to return false")
	}
	if VerifyPassword("pw", "scrypt$0011$zz") {
		t.Fatal("expected invalid scrypt key to return false")
	}
	if !VerifyPassword("legacy-plain", "legacy-plain") {
		t.Fatal("expected legacy plain comparison fallback to match identical string")
	}
}
