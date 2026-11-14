package gateway

import (
	"net/http"
	"strings"

	"collaborative-whiteboard/apps/backend/internal/auth"
	"collaborative-whiteboard/apps/backend/internal/storage"
)

type accountCredentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Nickname string `json:"nickname"`
}

func (s *Server) registerAccount(w http.ResponseWriter, r *http.Request) {
	var req accountCredentials
	if decodeJSON(r, &req) != nil {
		fail(w, 400, "请求格式错误")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.Nickname = strings.TrimSpace(req.Nickname)
	if len(req.Username) < 3 || len(req.Username) > 40 || len(req.Password) < 8 || len(req.Password) > 128 {
		fail(w, 400, "用户名需为 3 至 40 个字符，密码需为 8 至 128 个字符")
		return
	}
	if req.Nickname == "" {
		req.Nickname = req.Username
	}
	id, err := storage.RandomID()
	if err != nil {
		fail(w, 500, "创建账号失败")
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		fail(w, 500, "创建账号失败")
		return
	}
	account := storage.Account{ID: id, Username: req.Username, Nickname: req.Nickname}
	if err = s.store.CreateAccount(r.Context(), account, hash); err != nil {
		if isUniqueConstraintError(err) {
			fail(w, 409, "用户名已被使用")
		} else {
			fail(w, 500, "创建账号失败")
		}
		return
	}
	s.issueAccountSession(w, r, account)
}

func (s *Server) loginAccount(w http.ResponseWriter, r *http.Request) {
	var req accountCredentials
	if decodeJSON(r, &req) != nil {
		fail(w, 400, "请求格式错误")
		return
	}
	account, hash, err := s.store.AccountByUsername(r.Context(), strings.TrimSpace(req.Username))
	if err != nil || !auth.VerifyPassword(req.Password, hash) {
		s.notePasswordFailure(r)
		fail(w, 401, "用户名或密码错误")
		return
	}
	s.issueAccountSession(w, r, account)
}

func (s *Server) issueAccountSession(w http.ResponseWriter, r *http.Request, account storage.Account) {
	token, err := s.store.NewAccountSession(r.Context(), account.ID)
	if err != nil {
		fail(w, 500, "登录失败")
		return
	}
	ok(w, map[string]any{"account": account, "token": token})
}

func (s *Server) accountFromRequest(r *http.Request) (storage.Account, error) {
	return s.store.AccountByToken(r.Context(), bearerToken(r))
}

func (s *Server) accountProfile(w http.ResponseWriter, r *http.Request) {
	account, err := s.accountFromRequest(r)
	if err != nil {
		fail(w, 401, "请先登录")
		return
	}
	ok(w, account)
}

func (s *Server) updateAccountProfile(w http.ResponseWriter, r *http.Request) {
	account, err := s.accountFromRequest(r)
	if err != nil {
		fail(w, 401, "请先登录")
		return
	}
	var req struct {
		Nickname string `json:"nickname"`
	}
	if decodeJSON(r, &req) != nil || strings.TrimSpace(req.Nickname) == "" || len(req.Nickname) > 120 {
		fail(w, 400, "请输入有效昵称")
		return
	}
	account.Nickname = strings.TrimSpace(req.Nickname)
	if s.store.SetNickname(r.Context(), account.ID, account.Nickname) != nil {
		fail(w, 500, "保存昵称失败")
		return
	}
	ok(w, account)
}

func (s *Server) logoutAccount(w http.ResponseWriter, r *http.Request) {
	if _, err := s.accountFromRequest(r); err != nil {
		fail(w, 401, "请先登录")
		return
	}
	if s.store.LogoutAccount(r.Context(), bearerToken(r)) != nil {
		fail(w, 500, "退出失败")
		return
	}
	okNoData(w)
}
