package storage

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"time"
)

type Account struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Nickname string `json:"nickname"`
}

func RandomID() (string, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateAccount(ctx context.Context, account Account, passwordHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO users(user_id,username,password_hash,created_at) VALUES(?,?,?,?)`, account.ID, account.Username, passwordHash, time.Now().Unix()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO user_profiles(user_id,nickname) VALUES(?,?)`, account.ID, account.Nickname); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) AccountByUsername(ctx context.Context, username string) (Account, string, error) {
	var account Account
	var password string
	err := s.db.QueryRowContext(ctx, `SELECT u.user_id,u.username,COALESCE(p.nickname,u.username),u.password_hash FROM users u LEFT JOIN user_profiles p ON p.user_id=u.user_id WHERE u.username=? AND u.disabled=0`, username).Scan(&account.ID, &account.Username, &account.Nickname, &password)
	return account, password, err
}

func (s *Store) NewAccountSession(ctx context.Context, userID string) (string, error) {
	token, err := RandomID()
	if err != nil {
		return "", err
	}
	id, err := RandomID()
	if err != nil {
		return "", err
	}
	now := time.Now()
	_, err = s.db.ExecContext(ctx, `INSERT INTO auth_sessions(session_id,user_id,refresh_token_hash,expires_at,created_at) VALUES(?,?,?,?,?)`, id, userID, tokenHash(token), now.Add(30*24*time.Hour).Unix(), now.Unix())
	return token, err
}

func (s *Store) AccountByToken(ctx context.Context, token string) (Account, error) {
	var account Account
	err := s.db.QueryRowContext(ctx, `SELECT u.user_id,u.username,COALESCE(p.nickname,u.username) FROM auth_sessions a JOIN users u ON u.user_id=a.user_id LEFT JOIN user_profiles p ON p.user_id=u.user_id WHERE a.refresh_token_hash=? AND a.revoked_at IS NULL AND a.expires_at>? AND u.disabled=0`, tokenHash(token), time.Now().Unix()).Scan(&account.ID, &account.Username, &account.Nickname)
	return account, err
}

func (s *Store) RefreshAccountSession(ctx context.Context, token string) (string, error) {
	next, err := RandomID()
	if err != nil {
		return "", err
	}
	now := time.Now()
	result, err := s.db.ExecContext(ctx, `UPDATE auth_sessions SET refresh_token_hash=?, expires_at=? WHERE refresh_token_hash=? AND revoked_at IS NULL AND expires_at>?`, tokenHash(next), now.Add(30*24*time.Hour).Unix(), tokenHash(token), now.Unix())
	if err != nil {
		return "", err
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return "", sql.ErrNoRows
	}
	return next, nil
}

func (s *Store) LogoutAccount(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at=? WHERE refresh_token_hash=?`, time.Now().Unix(), tokenHash(token))
	return err
}

func (s *Store) SetNickname(ctx context.Context, userID, nickname string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO user_profiles(user_id,nickname) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET nickname=excluded.nickname`, userID, nickname)
	return err
}
