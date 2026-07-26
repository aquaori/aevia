package auth

import (
	"crypto/rand"
	"encoding/hex"
	"testing"

	"golang.org/x/crypto/scrypt"
)

// legacyScryptHash reproduces the pre-argon2id storage format so the
// compatibility path stays covered.
func legacyScryptHash(t *testing.T, password string) string {
	t.Helper()
	salt := make([]byte, saltBytes)
	if _, err := rand.Read(salt); err != nil {
		t.Fatalf("salt: %v", err)
	}
	key, err := scrypt.Key([]byte(password), salt, 1<<15, 8, 1, keyBytes)
	if err != nil {
		t.Fatalf("scrypt: %v", err)
	}
	return scryptPrefix + "$" + hex.EncodeToString(salt) + "$" + hex.EncodeToString(key)
}
