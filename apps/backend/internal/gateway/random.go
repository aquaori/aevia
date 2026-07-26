package gateway

import (
	"crypto/rand"
	"encoding/hex"
)

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "user-fallback"
	}
	return hex.EncodeToString(b[:])
}
