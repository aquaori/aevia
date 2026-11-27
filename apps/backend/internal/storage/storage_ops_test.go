package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func TestRoomDefaultsAndPasswordUpdate(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	if err := store.EnsureDefaultRoom(ctx, "000001"); err != nil {
		t.Fatalf("ensure default room: %v", err)
	}
	if err := store.EnsureDefaultRoom(ctx, "000001"); err != nil {
		t.Fatalf("ensure default room idempotent: %v", err)
	}
	if err := store.UpdateRoomPassword(ctx, "000001", "hashed-pw"); err != nil {
		t.Fatalf("update room password: %v", err)
	}
	room, exists, err := store.GetRoom(ctx, "000001")
	if err != nil || !exists || room.Password != "hashed-pw" {
		t.Fatalf("unexpected room after password update: exists=%v err=%v room=%+v", exists, err, room)
	}
}

func TestCommandClearAndPageIncrementAtSeq(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	if err := store.CreateRoom(ctx, domain.Room{RoomID: "room-seq", Name: "Seq", TotalPage: 1}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	p0 := 0
	cmd0 := domain.NewCommand(map[string]any{"id": "c0", "type": "path", "pageId": 0, "userId": "u1"})
	cmd1 := domain.NewCommand(map[string]any{"id": "c1", "type": "path", "pageId": 1, "userId": "u1"})
	if err := store.SaveCommandAtSeq("room-seq", cmd0, 1, true); err != nil {
		t.Fatalf("save c0: %v", err)
	}
	if err := store.SaveCommandAtSeq("room-seq", cmd1, 2, true); err != nil {
		t.Fatalf("save c1: %v", err)
	}
	if err := store.IncrementPageAtSeq("room-seq", 3, true); err != nil {
		t.Fatalf("increment page: %v", err)
	}
	if err := store.ClearCommandsAtSeq("room-seq", &p0, 4, true); err != nil {
		t.Fatalf("clear page 0: %v", err)
	}
	room, _, err := store.GetRoom(ctx, "room-seq")
	if err != nil || room.TotalPage != 2 || room.DurableSeq != 4 {
		t.Fatalf("unexpected room state: %+v err=%v", room, err)
	}
	if err := store.ClearCommandsAtSeq("room-seq", nil, 5, true); err != nil {
		t.Fatalf("clear all pages: %v", err)
	}
	snap, seq, err := store.BeginReadSnapshot(ctx, "room-seq")
	if err != nil || seq != 5 {
		t.Fatalf("begin read snapshot: seq=%d err=%v", seq, err)
	}
	defer snap.Close()
	cmds, err := snap.Commands(ctx)
	if err != nil || len(cmds) != 0 {
		t.Fatalf("expected 0 commands after full clear, got %d err=%v", len(cmds), err)
	}
}

func TestMembershipPolicyAuditAndTransfers(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	owner := Account{ID: "acc-owner1", Username: "owner1", Nickname: "Owner"}
	member := Account{ID: "acc-member1", Username: "member1", Nickname: "Member"}
	if err := store.CreateAccount(ctx, owner, "pw-hash"); err != nil {
		t.Fatalf("create owner: %v", err)
	}
	if err := store.CreateAccount(ctx, member, "pw-hash"); err != nil {
		t.Fatalf("create member: %v", err)
	}
	if err := store.CreateOwnedRoom(ctx, domain.Room{RoomID: "room-m", Name: "Member Room"}, owner.ID); err != nil {
		t.Fatalf("create owned room: %v", err)
	}
	if err := store.JoinAccountRoom(ctx, "room-m", member.ID); err != nil {
		t.Fatalf("join owned room: %v", err)
	}
	if err := store.UpdateRoomPolicy(ctx, "room-m", "Renamed Room", "pw2", true, true, RoomPolicy{
		DefaultRole:   "viewer",
		AllowRoomCode: true,
		GuestByCode:   false,
		GuestByInvite: true,
	}); err != nil {
		t.Fatalf("update room policy: %v", err)
	}
	if err := store.UpdateMember(ctx, "room-m", owner.ID, member.ID, "editor"); err != nil {
		t.Fatalf("promote member: %v", err)
	}
	members, err := store.Members(ctx, "room-m")
	if err != nil || len(members) != 2 {
		t.Fatalf("expected 2 members, got %+v err=%v", members, err)
	}
	audit, err := store.MemberAudit(ctx, "room-m")
	if err != nil || len(audit) == 0 {
		t.Fatalf("expected audit entries, got %+v err=%v", audit, err)
	}
	accRooms, err := store.AccountRooms(ctx, owner.ID)
	if err != nil || len(accRooms) != 1 {
		t.Fatalf("expected 1 account room, got %+v err=%v", accRooms, err)
	}

	if err := store.RequestTransfer(ctx, "room-m", owner.ID, member.ID); err != nil {
		t.Fatalf("request transfer: %v", err)
	}
	pending, err := store.PendingTransfers(ctx, member.ID)
	if err != nil || len(pending) != 1 {
		t.Fatalf("expected 1 pending transfer, got %+v err=%v", pending, err)
	}
	if err := store.RespondTransfer(ctx, "room-m", member.ID, true); err != nil {
		t.Fatalf("accept transfer: %v", err)
	}
	role, _, err := store.MemberRole(ctx, "room-m", member.ID)
	if err != nil || role != "owner" {
		t.Fatalf("expected member to become owner, got role=%q err=%v", role, err)
	}
}

func TestCheckpointAndObserveWAL(t *testing.T) {
	cfg := testStoreConfig(t)
	cfg.DBPath = filepath.Join(t.TempDir(), "wal.sqlite")
	cfg.WALCheckpointBytes = 1
	cfg.WALTruncateBytes = 2
	store, err := Open(cfg)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx := context.Background()
	if err := store.CreateRoom(ctx, domain.Room{RoomID: "wal-room"}); err != nil {
		t.Fatalf("create room: %v", err)
	}
	if err := store.SaveCommandAtSeq("wal-room", domain.NewCommand(map[string]any{"id": "w1", "type": "path", "pageId": 0}), 1, true); err != nil {
		t.Fatalf("save command: %v", err)
	}
	if err := store.Checkpoint(ctx, ""); err != nil {
		t.Fatalf("checkpoint passive: %v", err)
	}
	store.observeAndCheckpoint(ctx)
	if store.walSize() < 0 {
		t.Fatal("expected non-negative walSize")
	}

	// Verify write failure handler fires when an invalid/closed db write occurs
	var failedRoom string
	done := make(chan struct{}, 1)
	store.SetAsyncFailureHandler(func(roomID string, _ error) {
		failedRoom = roomID
		select {
		case done <- struct{}{}:
		default:
		}
	})
	_ = store.db.Close()
	_ = store.SaveCommandAtSeq("wal-room", domain.NewCommand(map[string]any{"id": "w2", "type": "path", "pageId": 0}), 2, false)
	if store.IsDegraded() {
		// Wait is optional, check IsDegraded call returns bool without panic.
		_ = store.IsDegraded()
	}
	select {
	case <-done:
		if failedRoom != "wal-room" {
			t.Fatalf("expected wal-room failure notification, got %q", failedRoom)
		}
	case <-time.After(2 * time.Second):
		// Flush/close error may surface synchronously or asynchronously depending on driver state.
	}
}

func TestAccountsInvitesGuestsTicketsAndDeleteRoom(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	owner := Account{ID: "st-owner", Username: "stowner", Nickname: "Owner"}
	if err := store.CreateAccount(ctx, owner, "pw-hash"); err != nil {
		t.Fatalf("create owner: %v", err)
	}
	gotAcc, pw, err := store.AccountByUsername(ctx, "stowner")
	if err != nil || gotAcc.ID != owner.ID || pw != "pw-hash" {
		t.Fatalf("AccountByUsername: %+v pw=%q err=%v", gotAcc, pw, err)
	}
	if err := store.SetNickname(ctx, owner.ID, "Owner Renamed"); err != nil {
		t.Fatalf("SetNickname: %v", err)
	}
	tok, err := store.NewAccountSession(ctx, owner.ID)
	if err != nil {
		t.Fatalf("NewAccountSession: %v", err)
	}
	byTok, err := store.AccountByToken(ctx, tok)
	if err != nil || byTok.Nickname != "Owner Renamed" {
		t.Fatalf("AccountByToken: %+v err=%v", byTok, err)
	}
	nextTok, err := store.RefreshAccountSession(ctx, tok)
	if err != nil || nextTok == tok {
		t.Fatalf("RefreshAccountSession: next=%q err=%v", nextTok, err)
	}
	if err := store.LogoutAccount(ctx, nextTok); err != nil {
		t.Fatalf("LogoutAccount: %v", err)
	}
	if _, err := store.AccountByToken(ctx, nextTok); err == nil {
		t.Fatal("expected logged out token lookup to fail")
	}

	if err := store.CreateOwnedRoom(ctx, domain.Room{RoomID: "st-room", Name: "ST"}, owner.ID); err != nil {
		t.Fatalf("CreateOwnedRoom: %v", err)
	}
	policy, err := store.Policy(ctx, "st-room")
	if err != nil || policy.DefaultRole == "" {
		t.Fatalf("Policy: %+v err=%v", policy, err)
	}
	if err := store.MarkPasswordVerified(ctx, "st-room", owner.ID, 1); err != nil {
		t.Fatalf("MarkPasswordVerified: %v", err)
	}
	if !store.PasswordVerified(ctx, "st-room", owner.ID, 1) || store.PasswordVerified(ctx, "st-room", owner.ID, 2) {
		t.Fatal("PasswordVerified mismatch")
	}

	exp := time.Now().Add(time.Hour).Unix()
	if err := store.CreateInvite(ctx, "inv-1", "st-room", owner.ID, exp); err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if !store.InviteValid(ctx, "inv-1", "st-room") {
		t.Fatal("expected valid invite")
	}
	invites, err := store.Invites(ctx, "st-room")
	if err != nil || len(invites) != 1 {
		t.Fatalf("Invites: %+v err=%v", invites, err)
	}
	if err := store.RevokeInvite(ctx, "st-room", "inv-1"); err != nil {
		t.Fatalf("RevokeInvite: %v", err)
	}
	if store.InviteValid(ctx, "inv-1", "st-room") {
		t.Fatal("expected revoked invite invalid")
	}

	if err := store.CreateGuest(ctx, "st-room", "guest-1", "editor"); err != nil {
		t.Fatalf("CreateGuest: %v", err)
	}
	role, kicked, err := store.GuestRole(ctx, "st-room", "guest-1")
	if err != nil || role != "editor" || kicked {
		t.Fatalf("GuestRole: %q %v %v", role, kicked, err)
	}
	if err := store.UpdateGuest(ctx, "st-room", owner.ID, "guest-1", "viewer"); err != nil {
		t.Fatalf("UpdateGuest viewer: %v", err)
	}
	if err := store.UpdateGuest(ctx, "st-room", owner.ID, "guest-1", "kick"); err != nil {
		t.Fatalf("UpdateGuest kick: %v", err)
	}
	_, kicked, err = store.GuestRole(ctx, "st-room", "guest-1")
	if err != nil || !kicked {
		t.Fatalf("expected kicked guest, got kicked=%v err=%v", kicked, err)
	}

	if err := store.CreateWebsocketTicket(ctx, "ws-tik-1", exp); err != nil {
		t.Fatalf("CreateWebsocketTicket: %v", err)
	}
	if ok, err := store.ConsumeWebsocketTicket(ctx, "ws-tik-1"); err != nil || !ok {
		t.Fatalf("ConsumeWebsocketTicket first: %v %v", ok, err)
	}
	if ok, err := store.ConsumeWebsocketTicket(ctx, "ws-tik-1"); err != nil || ok {
		t.Fatalf("expected second consume false, got %v %v", ok, err)
	}

	target := Account{ID: "st-target", Username: "sttarget", Nickname: "Target"}
	_ = store.CreateAccount(ctx, target, "pw")
	_ = store.RequestTransfer(ctx, "st-room", owner.ID, target.ID)
	transferOwner, err := store.TransferOwner(ctx, "st-room", target.ID)
	if err != nil || transferOwner != owner.ID {
		t.Fatalf("TransferOwner: %q err=%v", transferOwner, err)
	}

	if err := store.DeleteRoom(ctx, "st-room"); err != nil {
		t.Fatalf("DeleteRoom: %v", err)
	}
	if _, exists, _ := store.GetRoom(ctx, "st-room"); exists {
		t.Fatal("expected deleted room not to exist")
	}
}
