package gateway

import "net/http"

func (s *Server) requestTransfer(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.roomAccount(w, r, true)
	if !ok {
		return
	}
	var req struct {
		UserID string `json:"userId"`
	}
	if decodeJSON(r, &req) != nil || req.UserID == owner.ID {
		fail(w, 400, "请选择其他成员")
		return
	}
	role, banned, err := s.store.MemberRole(r.Context(), r.PathValue("roomId"), req.UserID)
	if err != nil || role == "" || banned {
		fail(w, 400, "接收方必须是房间成员")
		return
	}
	if err = s.store.RequestTransfer(r.Context(), r.PathValue("roomId"), owner.ID, req.UserID); err != nil {
		fail(w, 500, "发起转让失败")
		return
	}
	okNoData(w)
}

func (s *Server) pendingTransfers(w http.ResponseWriter, r *http.Request) {
	account, err := s.accountFromRequest(r)
	if err != nil {
		fail(w, 401, "请先登录")
		return
	}
	items, err := s.store.PendingTransfers(r.Context(), account.ID)
	if err != nil {
		fail(w, 500, "无法获取转让请求")
		return
	}
	ok(w, items)
}

func (s *Server) respondTransfer(w http.ResponseWriter, r *http.Request) {
	account, err := s.accountFromRequest(r)
	if err != nil {
		fail(w, 401, "请先登录")
		return
	}
	var req struct {
		Accept bool `json:"accept"`
	}
	if decodeJSON(r, &req) != nil {
		fail(w, 400, "请求无效")
		return
	}
	if err = s.store.RespondTransfer(r.Context(), r.PathValue("roomId"), account.ID, req.Accept); err != nil {
		fail(w, 400, "转让请求已失效")
		return
	}
	okNoData(w)
}

func (s *Server) deleteRoom(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.roomAccount(w, r, true); !ok {
		return
	}
	id := r.PathValue("roomId")
	actor, err := s.registry.Get(r.Context(), id)
	if err != nil {
		fail(w, 500, "无法关闭房间")
		return
	}
	actor.Shutdown(r.Context())
	if err = s.store.DeleteRoom(r.Context(), id); err != nil {
		fail(w, 500, "删除房间失败")
		return
	}
	okNoData(w)
}
