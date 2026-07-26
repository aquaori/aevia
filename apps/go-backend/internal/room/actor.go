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

// actorIdleTimeout is how long a room with no connected clients is kept warm
// before its actor is evicted and its state released.
const actorIdleTimeout = 10 * time.Minute

// ErrActorStopped is returned when an operation targets a room actor whose loop
// has already exited (idle eviction or shutdown). Callers should treat it as a
// retryable condition: the registry mints a fresh actor on the next lookup.
var ErrActorStopped = errors.New("room actor stopped")

// ErrActorBusy is returned when the reliable inbox is saturated.
var ErrActorBusy = errors.New("room actor busy")

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
	release             func(*Actor)
	writeFailures       chan error
	state               State
	builder             SnapshotBuilder
	metrics             Metrics
	draining            bool
	pressureLevel       pressureLevel
	pressureLastSent    time.Time
	pressureLastChecked time.Time
	pressureLastMetrics MetricsSnapshot
}

// NewActor loads room state and starts the actor loop. release is invoked once,
// from the actor goroutine, right before the loop exits so the owner can drop
// its reference before any new caller can observe a stopped actor.
func NewActor(ctx context.Context, store *storage.Store, cfg config.Config, roomID string, release func(*Actor)) (*Actor, error) {
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
	if release == nil {
		release = func(*Actor) {}
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
		release:         release,
		writeFailures:   make(chan error, 1),
		state:           NewState(roomData, commands),
		builder:         NewSnapshotBuilder(cfg),
		pressureLevel:   pressureNormal,
	}
	go actor.loop()
	return actor, nil
}

// NotifyWriteFailure reports an asynchronous persistence failure to the actor,
// which will enter read-only mode from its own goroutine. Non-blocking: one
// queued notification is enough to trigger degradation.
func (a *Actor) NotifyWriteFailure(err error) {
	if err == nil {
		return
	}
	select {
	case a.writeFailures <- err:
	default:
	}
}

// Stopped reports whether the actor loop has exited.
func (a *Actor) Stopped() bool {
	select {
	case <-a.done:
		return true
	default:
		return false
	}
}

// RoomID exposes the room this actor owns.
func (a *Actor) RoomID() string {
	return a.roomID
}

func (a *Actor) Join(client ClientInfo, pageID int, lastRoomSeq uint64) (JoinResult, error) {
	reply := make(chan JoinResult, 1)
	if err := a.sendReliable(joinMessage{Client: client, PageID: pageID, LastRoomSeq: lastRoomSeq, Reply: reply}); err != nil {
		return JoinResult{}, err
	}
	select {
	case result := <-reply:
		return result, nil
	case <-a.done:
		return JoinResult{}, ErrActorStopped
	}
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
	select {
	case result := <-reply:
		return result, nil
	case <-a.done:
		return InitStream{}, ErrActorStopped
	}
}

func (a *Actor) PageReview() (PageReview, error) {
	reply := make(chan PageReview, 1)
	if err := a.sendReliable(pageReviewRequest{Reply: reply}); err != nil {
		return PageReview{}, err
	}
	select {
	case result := <-reply:
		return result, nil
	case <-a.done:
		return PageReview{}, ErrActorStopped
	}
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
	case <-a.done:
		return ErrActorStopped
	default:
	}
	select {
	case a.inbox <- msg:
		return nil
	case <-a.done:
		return ErrActorStopped
	default:
		a.metrics.ReliableRejected.Add(1)
		return ErrActorBusy
	}
}

func (a *Actor) loop() {
	defer a.shutdownLoop()
	idleTimer := time.NewTimer(actorIdleTimeout)
	defer idleTimer.Stop()
	for {
		select {
		case msg := <-a.inbox:
			if a.handle(msg) {
				return
			}
			resetTimer(idleTimer, actorIdleTimeout)
		case msg := <-a.realtime:
			if a.handle(msg) {
				return
			}
		case <-a.realtimeWake:
			a.flushMergedRealtime()
		case err := <-a.writeFailures:
			a.enterReadOnly("asynchronous persist failed", err)
		case <-idleTimer.C:
			// Only evict when the room is genuinely idle: an empty client set with
			// queued work still has messages to drain.
			if len(a.state.Clients) == 0 && len(a.inbox) == 0 && len(a.realtime) == 0 {
				slog.Info("room actor evicted after idle timeout", "room", a.roomID)
				return
			}
			resetTimer(idleTimer, actorIdleTimeout)
		}
	}
}

// shutdownLoop detaches the actor from its owner before unblocking waiters, so
// no caller can obtain a reference to a stopped actor. Any request that raced
// into the inbox is answered from a.done by its caller.
func (a *Actor) shutdownLoop() {
	a.release(a)
	close(a.done)
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
	// Rate-limited internally; see pressureSampleInterval. Sampling must stay
	// unconditional because pressure can originate in a client's send queue even
	// when this actor's own inbox is drained.
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
		drainOutbound(client.Send)
		sendOutbound(client.Send, Outbound{JSON: Envelope{Type: "server.draining", Data: map[string]any{"reason": reason, "roomSeq": a.state.RoomSeq}}})
		sendOutbound(client.Send, Outbound{Close: true})
	}
}

// drainOutbound discards anything still queued for a client so the final
// draining notice and close marker always fit in the buffer.
func drainOutbound(ch chan Outbound) {
	for {
		select {
		case <-ch:
		default:
			return
		}
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
