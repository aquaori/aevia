package gateway

import (
	"net/http"
	"strings"

	"collaborative-whiteboard/apps/backend/internal/auth"
	"collaborative-whiteboard/apps/backend/internal/storage"
)

func (s *Server) roomAccount(w http.ResponseWriter, r *http.Request, owner bool) (storage.Account, bool) {
	account, err := s.accountFromRequest(r)
	if err != nil {
		fail(w, 401, "请先登录")
		return account, false
	}
	role, banned, err := s.store.MemberRole(r.Context(), r.PathValue("roomId"), account.ID)
	if err != nil {
		fail(w, 500, "无法读取成员信息")
		return account, false
	}
	if banned || role == "" || (owner && role != "owner") {
		fail(w, 403, "没有权限执行此操作")
		return account, false
	}
	return account, true
}

func (s *Server) roomMembers(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.roomAccount(w, r, false); !ok {
		return
	}
	members, err := s.store.Members(r.Context(), r.PathValue("roomId"))
	if err != nil {
		fail(w, 500, "无法获取成员")
		return
	}
	ok(w, members)
}

func (s *Server) getRoomSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.roomAccount(w, r, true); !ok {
		return
	}
	id := r.PathValue("roomId")
	policy, err := s.store.Policy(r.Context(), id)
	if err != nil {
		fail(w, 500, "无法读取设置")
		return
	}
	room, exists, err := s.store.GetRoom(r.Context(), id)
	if err != nil || !exists {
		fail(w, 404, "房间不存在")
		return
	}
	ok(w, map[string]any{"name": room.Name, "passwordRequired": room.Password != "", "policy": policy})
}

func (s *Server) updateRoomSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.roomAccount(w, r, true); !ok {
		return
	}
	var req struct {
		Name            string             `json:"name"`
		Password        string             `json:"password"`
		SetPassword     bool               `json:"setPassword"`
		RequirePassword bool               `json:"requirePassword"`
		Policy          storage.RoomPolicy `json:"policy"`
	}
	if decodeJSON(r, &req) != nil || strings.TrimSpace(req.Name) == "" || (req.Policy.DefaultRole != "editor" && req.Policy.DefaultRole != "viewer") {
		fail(w, 400, "房间设置无效")
		return
	}
	password := ""
	var err error
	if req.SetPassword {
		password, err = auth.HashPassword(req.Password)
		if err != nil {
			fail(w, 500, "密码保存失败")
			return
		}
	}
	if err = s.store.UpdateRoomPolicy(r.Context(), r.PathValue("roomId"), strings.TrimSpace(req.Name), password, req.SetPassword, req.RequirePassword, req.Policy); err != nil {
		fail(w, 500, "设置保存失败")
		return
	}
	okNoData(w)
}

func (s *Server) leaveRoom(w http.ResponseWriter, r *http.Request) {
	account, ok := s.roomAccount(w, r, false)
	if !ok {
		return
	}
	role, _, _ := s.store.MemberRole(r.Context(), r.PathValue("roomId"), account.ID)
	if role == "owner" {
		fail(w, 400, "房主需要先转让房间")
		return
	}
	if err := s.store.UpdateMember(r.Context(), r.PathValue("roomId"), account.ID, "leave"); err != nil {
		fail(w, 500, "退出失败")
		return
	}
	okNoData(w)
}

func (s *Server) changeMember(w http.ResponseWriter, r *http.Request, action string) {
	if _, ok := s.roomAccount(w, r, true); !ok {
		return
	}
	userID := r.PathValue("userId")
	role, _, err := s.store.MemberRole(r.Context(), r.PathValue("roomId"), userID)
	if err != nil || role == "" || role == "owner" {
		fail(w, 400, "无法修改此成员")
		return
	}
	if err = s.store.UpdateMember(r.Context(), r.PathValue("roomId"), userID, action); err != nil {
		fail(w, 500, "成员操作失败")
		return
	}
	okNoData(w)
}

func (s *Server) changeMemberRole(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Role string `json:"role"`
	}
	if decodeJSON(r, &req) != nil || (req.Role != "editor" && req.Role != "viewer") {
		fail(w, 400, "角色无效")
		return
	}
	s.changeMember(w, r, req.Role)
}
func (s *Server) kickMember(w http.ResponseWriter, r *http.Request)  { s.changeMember(w, r, "kick") }
func (s *Server) banMember(w http.ResponseWriter, r *http.Request)   { s.changeMember(w, r, "ban") }
func (s *Server) unbanMember(w http.ResponseWriter, r *http.Request) { s.changeMember(w, r, "unban") }
