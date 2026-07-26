package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Claims struct {
	UserID           string `json:"userId"`
	UserName         string `json:"userName"`
	RoomID           string `json:"roomId"`
	RoomName         string `json:"roomName"`
	RoomCreatedAt    int64  `json:"roomCreatedAt"`
	PasswordRequired bool   `json:"passwordRequired,omitempty"`
	TokenType        string `json:"tokenType"`
	Exp              int64  `json:"exp"`
	Iat              int64  `json:"iat"`
}

type TokenService struct {
	secret []byte
}

func NewTokenService(secret string) TokenService {
	return TokenService{secret: []byte(secret)}
}

func (s TokenService) Sign(claims Claims, ttl time.Duration) (string, int64, error) {
	now := time.Now()
	claims.Iat = now.Unix()
	claims.Exp = now.Add(ttl).Unix()
	header := map[string]string{"alg": "HS256", "typ": "JWT"}
	headerJSON, _ := json.Marshal(header)
	payloadJSON, err := json.Marshal(claims)
	if err != nil {
		return "", 0, err
	}
	unsigned := b64(headerJSON) + "." + b64(payloadJSON)
	sig := s.sign(unsigned)
	return unsigned + "." + b64(sig), claims.Exp * 1000, nil
}

func (s TokenService) Verify(token, tokenType string) (Claims, error) {
	var claims Claims
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return claims, errors.New("invalid token")
	}
	unsigned := parts[0] + "." + parts[1]
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return claims, err
	}
	if !hmac.Equal(s.sign(unsigned), sig) {
		return claims, errors.New("invalid signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, err
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return claims, err
	}
	if claims.TokenType != tokenType {
		return claims, errors.New("wrong token type")
	}
	if claims.Exp > 0 && claims.Exp < time.Now().Unix() {
		return claims, errors.New("token expired")
	}
	return claims, nil
}

func (s TokenService) sign(unsigned string) []byte {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(unsigned))
	return mac.Sum(nil)
}

func b64(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}
