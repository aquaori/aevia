package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/scrypt"
)

const (
	scryptPrefix = "scrypt"
	argonPrefix  = "argon2id"
	saltBytes    = 16
	keyBytes     = 32
	argonMemory  = 32 * 1024
	argonTime    = 1
	argonThreads = 1
)

var hashPool = make(chan struct{}, 2)
var hashQueueTimeout = 1500 * time.Millisecond

func ConfigureHashPool(size int, timeout time.Duration) {
	if size < 1 {
		size = 1
	}
	hashPool = make(chan struct{}, size)
	if timeout > 0 {
		hashQueueTimeout = timeout
	}
}

func HashPassword(password string) (string, error) {
	if password == "" {
		return "", nil
	}
	release, err := acquireHashSlot()
	if err != nil {
		return "", err
	}
	defer release()
	salt := make([]byte, saltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, keyBytes)
	return fmt.Sprintf("%s$m=%d,t=%d,p=%d$%s$%s",
		argonPrefix, argonMemory, argonTime, argonThreads, hex.EncodeToString(salt), hex.EncodeToString(key)), nil
}

func VerifyPassword(password, stored string) bool {
	if stored == "" {
		return password == ""
	}
	release, err := acquireHashSlot()
	if err != nil {
		return false
	}
	defer release()
	parts := strings.Split(stored, "$")
	if len(parts) == 4 && parts[0] == argonPrefix {
		return verifyArgon2ID(password, parts)
	}
	if len(parts) != 3 || parts[0] != scryptPrefix {
		return stored == password
	}
	salt, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}
	expected, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	key, err := scrypt.Key([]byte(password), salt, 1<<15, 8, 1, len(expected))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(key, expected) == 1
}

func verifyArgon2ID(password string, parts []string) bool {
	salt, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	expected, err := hex.DecodeString(parts[3])
	if err != nil {
		return false
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, uint32(len(expected)))
	return subtle.ConstantTimeCompare(key, expected) == 1
}

func acquireHashSlot() (func(), error) {
	timer := time.NewTimer(hashQueueTimeout)
	defer timer.Stop()
	select {
	case hashPool <- struct{}{}:
		return func() { <-hashPool }, nil
	case <-timer.C:
		return nil, errors.New("password hash pool is busy")
	}
}
