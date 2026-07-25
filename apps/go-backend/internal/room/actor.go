package room

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"collaborative-whiteboard/apps/go-backend/internal/config"
	"collaborative-whiteboard/apps/go-backend/internal/storage"
)

type Actor struct {
	roomID              string
	store               *storage.Store
	cfg                 config.Config
	inbox               chan actorMessage
	realtime            chan actorMessage
	realtimeWake        chan struct{}
	realtimeMu          sync.Mutex
	pendingRealtime     map[string]clientEventMessage
	done                chan struct{}
	state               State
	builder             SnapshotBuilder
	metrics             Metrics
	draining            bool
	pressureLevel       pressureLevel
	pressureLastSent    time.Time
	pressureLastMetrics MetricsSnapshot
}

func NewActor(ctx context.Context, store *storage.Store, cfg config.Config, roomID string) (*Actor, error) {
	roomData, ok, err := store.GetRoom(ctx, roomID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("room not found")
	}
	commands, err := store.ListCommands(ctx, roomID)
	if err != nil {
		return nil, err
	}
	actor := &Actor{
		roomID:          roomID,
		store:           store,
		cfg:             cfg,
		inbox:           make(chan actorMessage, cfg.RoomReliableQueue),
		realtime:        make(chan actorMessage, cfg.RoomRealtimeQueue),
		realtimeWake:    make(chan struct{}, 1),
		pendingRealtime: make(map[string]clientEventMessage),
		done:            make(chan struct{}),
		state:           NewState(roomData, commands),
		builder:         NewSnapshotBuilder(cfg),
		pressureLevel:   pressureNormal,
	}
	go actor.loop()
	return actor, nil
}

func (a *Actor) Join(client ClientInfo, pageID int, lastRoomSeq uint64) (JoinResult, error) {
	reply := make(chan JoinResult, 1)
	if err := a.sendReliable(joinMessage{Client: client, PageID: pageID, LastRoomSeq: lastRoomSeq, Reply: reply}); err != nil {
		return JoinResult{}, err
	}
	return <-reply, nil
}

func (a *Actor) Leave(clientID ClientID) {
	_ = a.sendReliable(leaveMessage{ClientID: clientID})
}

func (a *Actor) Event(clientID ClientID, typ string, data map[string]any, binary bool) error {
	msg := clientEventMessage{ClientID: clientID, Type: typ, Data: data, Binary: binary}
	if isRealtime(typ) {
		select {
		case a.realtime <- msg:
			return nil
		default:
			a.metrics.RealtimeDropped.Add(1)
			a.mergeRealtime(msg)
			return nil
		}
	}
	return a.sendReliable(msg)
}

func (a *Actor) BinaryEvent(clientID ClientID, typ string, data map[string]any, frame []byte) error {
	msg := clientEventMessage{ClientID: clientID, Type: typ, Data: data, Binary: true, Frame: frame}
	return a.sendReliable(msg)
}

func (a *Actor) PageChange(clientID ClientID, req PageChangeRequest) error {
	return a.sendReliable(pageChangeMessage{ClientID: clientID, Request: req})
}

func (a *Actor) Snapshot(pageID int) (InitStream, error) {
	reply := make(chan InitStream, 1)
	if err := a.sendReliable(snapshotRequest{PageID: pageID, Reply: reply}); err != nil {
		return InitStream{}, err
	}
	return <-reply, nil
}

func (a *Actor) PageReview() (PageReview, error) {
	reply := make(chan PageReview, 1)
	if err := a.sendReliable(pageReviewRequest{Reply: reply}); err != nil {
		return PageReview{}, err
	}
	return <-reply, nil
}

func (a *Actor) Shutdown(ctx context.Context) {
	reply := make(chan struct{}, 1)
	select {
	case a.inbox <- shutdownMessage{Reason: "server shutdown", Reply: reply}:
	case <-a.done:
		return
	case <-ctx.Done():
		return
	}
	select {
	case <-reply:
	case <-a.done:
	case <-ctx.Done():
	}
}

func (a *Actor) BeginDraining(reason string) {
	_ = a.sendReliable(drainingMessage{Reason: reason})
}

func (a *Actor) sendReliable(msg actorMessage) error {
	select {
	case a.inbox <- msg:
		return nil
	default:
		a.metrics.ReliableRejected.Add(1)
		return errors.New("room actor busy")
	}
}

func (a *Actor) loop() {
	defer close(a.done)
	idleTimer := time.NewTimer(10 * time.Minute)
	defer idleTimer.Stop()
	for {
		select {
		case msg := <-a.inbox:
			if a.handle(msg) {
				return
			}
			resetTimer(idleTimer, 10*time.Minute)
		case msg := <-a.realtime:
			if a.handle(msg) {
				return
			}
		case <-a.realtimeWake:
			a.flushMergedRealtime()
		case <-idleTimer.C:
			if len(a.state.Clients) == 0 {
				return
			}
			resetTimer(idleTimer, 10*time.Minute)
		}
	}
}

func (a *Actor) Stats() MetricsSnapshot {
	return a.metrics.Snapshot()
}

func (a *Actor) mergeRealtime(msg clientEventMessage) {
	key := string(msg.ClientID) + ":" + msg.Type
	a.realtimeMu.Lock()
	if _, exists := a.pendingRealtime[key]; exists {
		a.metrics.RealtimeMerged.Add(1)
	}
	a.pendingRealtime[key] = msg
	a.realtimeMu.Unlock()
	select {
	case a.realtimeWake <- struct{}{}:
	default:
	}
}

func (a *Actor) flushMergedRealtime() {
	a.realtimeMu.Lock()
	pending := make([]clientEventMessage, 0, len(a.pendingRealtime))
	for key, msg := range a.pendingRealtime {
		pending = append(pending, msg)
		delete(a.pendingRealtime, key)
	}
	a.realtimeMu.Unlock()
	for _, msg := range pending {
		if a.handle(msg) {
			return
		}
	}
}

func (a *Actor) handle(msg actorMessage) bool {
	switch m := msg.(type) {
	case joinMessage:
		a.handleJoin(m)
	case leaveMessage:
		a.handleLeave(m)
	case clientEventMessage:
		a.handleClientEvent(m)
	case pageChangeMessage:
		a.handlePageChange(m)
	case snapshotRequest:
		m.Reply <- a.builder.Init(a.state, m.PageID)
	case pageReviewRequest:
		m.Reply <- a.state.PageReview()
	case drainingMessage:
		a.handleDraining(m.Reason)
	case shutdownMessage:
		a.handleDraining(m.Reason)
		a.closeClients("server shutdown")
		close(m.Reply)
		return true
	}
	a.maybeBroadcastPressure(time.Now())
	return false
}

func (a *Actor) handleDraining(reason string) {
	if a.draining {
		return
	}
	a.draining = true
	a.broadcastAll(Envelope{Type: "server.draining", Data: map[string]any{"reason": reason, "roomSeq": a.state.RoomSeq}}, nil)
}

func (a *Actor) closeClients(reason string) {
	for _, client := range a.state.Clients {
		for {
			select {
			case <-client.Send:
			default:
				sendOutbound(client.Send, Outbound{JSON: Envelope{Type: "server.draining", Data: map[string]any{"reason": reason, "roomSeq": a.state.RoomSeq}}})
				sendOutbound(client.Send, Outbound{Close: true})
				goto nextClient
			}
		}
	nextClient:
	}
}

func (a *Actor) handleJoin(msg joinMessage) {
	client := msg.Client
	client.PageID = normalizePageID(msg.PageID, a.state.Room.TotalPage)
	a.state.Clients[client.ID] = client
	deltas, ok := a.state.Deltas.Since(msg.LastRoomSeq)
	if msg.LastRoomSeq == 0 || !ok {
		deltas = nil
	}
	online := len(a.state.Clients)
	members := a.state.OnlineMembers()
	result := JoinResult{Room: a.state.Room, Deltas: deltas, Online: online, Members: members}
	if len(deltas) == 0 {
		a.builder.SendLiveInitStream(client.Send, a.state, client, online, members)
		result.InitStreamed = true
	}
	msg.Reply <- result
	a.broadcastExcept(client.ID, Envelope{Type: "online-count-change", Data: map[string]any{
		"onlineCount": len(a.state.Clients), "userId": client.UserID, "userName": client.UserName, "type": "join",
	}}, nil)
}

func (a *Actor) handleLeave(msg leaveMessage) {
	client, ok := a.state.Clients[msg.ClientID]
	if !ok {
		return
	}
	delete(a.state.Clients, msg.ClientID)
	a.broadcastExcept(msg.ClientID, Envelope{Type: "online-count-change", Data: map[string]any{
		"onlineCount": len(a.state.Clients), "userId": client.UserID, "userName": client.UserName, "type": "leave",
	}}, nil)
}

func (a *Actor) handlePageChange(msg pageChangeMessage) {
	client, ok := a.state.Clients[msg.ClientID]
	if !ok {
		return
	}
	stream := a.builder.PageChange(a.state, msg.Request)
	client.PageID = normalizePageID(valueOr(msg.Request.PageID, client.PageID), a.state.Room.TotalPage)
	if msg.Request.NextPageID != nil {
		client.PageID = normalizePageID(*msg.Request.NextPageID, a.state.Room.TotalPage)
	}
	a.state.Clients[msg.ClientID] = client
	sendPageChangeStream(client.Send, stream)
}

func (a *Actor) broadcastExcept(exclude ClientID, json any, binary []byte) {
	msg := sharedBroadcastOutbound(json, binary)
	for id, client := range a.state.Clients {
		if id == exclude {
			continue
		}
		if !sendOutbound(client.Send, msg) {
			a.metrics.SlowClients.Add(1)
		}
	}
}

func (a *Actor) broadcastAll(json any, binary []byte) {
	msg := sharedBroadcastOutbound(json, binary)
	for _, client := range a.state.Clients {
		if !sendOutbound(client.Send, msg) {
			a.metrics.SlowClients.Add(1)
		}
	}
}

func sharedBroadcastOutbound(json any, binary []byte) Outbound {
	if binary != nil {
		return Outbound{Binary: binary, Frozen: true, Bytes: len(binary)}
	}
	if json != nil {
		return freezeJSONOutbound(json)
	}
	return Outbound{Frozen: true}
}

func sendOutbound(ch chan Outbound, msg Outbound) bool {
	if !msg.Frozen {
		msg = snapshotOutbound(msg)
	}
	select {
	case ch <- msg:
		return true
	default:
		select {
		case ch <- Outbound{JSON: Envelope{Type: "resync.required", Data: map[string]any{"reason": "slow client"}}, Close: true}:
			return false
		default:
			return false
		}
	}
}

func resetTimer(timer *time.Timer, duration time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(duration)
}

func isRealtime(typ string) bool {
	return typ == "mouseMove" || typ == "mouseLeave" || typ == "box-selection"
}

func logActorError(msg string, err error) {
	if err != nil {
		slog.Warn(msg, "error", err)
	}
}
