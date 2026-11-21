package room

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"sync"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/domain"
	"collaborative-whiteboard/apps/backend/internal/storage"
)

// actorIdleTimeout is how long a room with no connected clients is kept warm
// before its actor is evicted and its state released.
const actorIdleTimeout = 10 * time.Minute

// Bound concurrent snapshot readers so joins cannot exhaust the SQLite pool.
var snapshotSlots = make(chan struct{}, 4)

func (a *Actor) pinSnapshot() (*storage.ReadSnapshot, context.Context, context.CancelFunc, error) {
	return a.pinSnapshotFor(15 * time.Second)
}

func (a *Actor) pinSnapshotFor(timeout time.Duration) (*storage.ReadSnapshot, context.Context, context.CancelFunc, error) {
	select {
	case snapshotSlots <- struct{}{}:
	default:
		return nil, nil, nil, ErrActorBusy
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	snapshot, seq, err := a.store.BeginReadSnapshot(ctx, a.roomID)
	if err == nil && seq != a.state.RoomSeq {
		err = errors.New("snapshot sequence mismatch")
	}
	if err != nil {
		if snapshot != nil {
			snapshot.Close()
		}
		cancel()
		<-snapshotSlots
		return nil, nil, nil, err
	}
	return snapshot, ctx, cancel, nil
}

func readSnapshot(snapshot *storage.ReadSnapshot, ctx context.Context, cancel context.CancelFunc) ([]domain.Command, error) {
	defer func() { snapshot.Close(); cancel() }()
	return snapshot.Commands(ctx)
}

// Load pre-clear history only after the client has finished its initial scene.
// The history stream uses the pinned room sequence and shares the normal ordered
// outbound queue with live operations, without blocking the room actor.
func (a *Actor) loadPageHistory(client ClientInfo, data map[string]any) {
	requestID := domain.String(data["requestId"])
	page, ok := domain.Int(data["pageId"])
	if requestID == "" || !ok || page != client.PageID {
		return
	}
	watermark, cleared := a.state.ClearBefore[page]
	if !cleared {
		version := a.state.RoomSeq
		go func() {
			sender := &streamSender{out: client.Send, abort: client.Abort, done: client.Done, wait: true}
			sendStreamOutbound(sender, Outbound{JSON: Envelope{Type: "page-history-meta", Data: map[string]any{"requestId": requestID, "pageId": page, "snapshotVersion": version, "resumed": false}}})
			sendStreamOutbound(sender, Outbound{JSON: Envelope{Type: "page-history-complete", Data: map[string]any{"requestId": requestID, "pageId": page}}})
		}()
		return
	}
	snapshot, ctx, cancel, err := a.pinSnapshotFor(2 * time.Minute)
	if err != nil {
		go func() {
			sender := &streamSender{out: client.Send, abort: client.Abort, done: client.Done, wait: true}
			sendStreamOutbound(sender, Outbound{JSON: Envelope{Type: "page-history-failed", Data: map[string]any{"requestId": requestID, "pageId": page}}})
		}()
		return
	}
	hidden := hiddenClearedPaths(a.state.Commands, map[int]sceneOrderKey{page: watermark})
	ids := make([]string, 0)
	for _, cmd := range a.state.Commands {
		p, valid := cmd.PageID()
		if valid && p == page && (!commandVisibleAfterClear(cmd, map[int]sceneOrderKey{page: watermark}) || isHiddenPathAppend(cmd, hidden)) {
			ids = append(ids, cmd.ID())
		}
	}
	sort.Strings(ids)
	version := a.state.RoomSeq
	requestedVersion, validVersion := domain.Int(data["snapshotVersion"])
	cursor := domain.String(data["cursor"])
	resumed := validVersion && uint64(requestedVersion) == version && cursor != ""
	startIndex := 0
	if resumed {
		startIndex = sort.SearchStrings(ids, cursor)
		for startIndex < len(ids) && ids[startIndex] <= cursor {
			startIndex++
		}
	}
	go func() {
		defer func() { snapshot.Close(); cancel(); <-snapshotSlots }()
		sender := &streamSender{out: client.Send, abort: client.Abort, done: client.Done, wait: true}
		sendStreamOutbound(sender, Outbound{JSON: Envelope{Type: "page-history-meta", Data: map[string]any{"requestId": requestID, "pageId": page, "snapshotVersion": version, "resumed": resumed}}})
		for start := startIndex; start < len(ids); start += 32 {
			end := min(start+32, len(ids))
			commands, err := snapshot.CommandsByID(ctx, ids[start:end])
			if err != nil || len(commands) != end-start {
				sendStreamOutbound(sender, Outbound{JSON: Envelope{Type: "page-history-failed", Data: map[string]any{"requestId": requestID, "pageId": page}}})
				return
			}
			sendStreamOutbound(sender, Outbound{JSON: Envelope{Type: "page-history-chunk", Data: map[string]any{"requestId": requestID, "pageId": page, "cursor": ids[end-1], "commands": commands}}})
			if sender.failed {
				return
			}
			select {
			case <-client.Done:
				return
			case <-time.After(time.Millisecond):
			}
		}
		sendStreamOutbound(sender, Outbound{JSON: Envelope{Type: "page-history-complete", Data: map[string]any{"requestId": requestID, "pageId": page}}})
	}()
}

// ErrActorStopped is returned when an operation targets a room actor whose loop
// has already exited (idle eviction or shutdown). Callers should treat it as a
// retryable condition: the registry mints a fresh actor on the next lookup.
var ErrActorStopped = errors.New("room actor stopped")

// ErrActorBusy is returned when the reliable inbox is saturated.
var ErrActorBusy = errors.New("room actor busy")

// ErrRoomAccessRevoked rejects a join whose authorization changed while queued.
var ErrRoomAccessRevoked = errors.New("room access revoked")

type Actor struct {
	roomID              string
	store               *storage.Store
	cfg                 config.Config
	inbox               chan actorMessage
	realtime            chan actorMessage
	realtimeWake        chan struct{}
	realtimeMu          sync.Mutex
	pendingRealtime     map[string]clientEventMessage
	noticeMu            sync.Mutex
	notices             []notifyUserMessage
	noticeWake          chan struct{}
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
		noticeWake:      make(chan struct{}, 1),
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
		return result, result.err
	case <-a.done:
		return JoinResult{}, ErrActorStopped
	}
}

func (a *Actor) Leave(clientID ClientID) {
	_ = a.sendReliable(leaveMessage{ClientID: clientID})
}

func (a *Actor) NotifyUser(userID, typ, role string, close bool) error {
	select {
	case <-a.done:
		return ErrActorStopped
	default:
	}
	a.noticeMu.Lock()
	a.notices = append(a.notices, notifyUserMessage{UserID: userID, Type: typ, Role: role, Close: close})
	a.noticeMu.Unlock()
	select {
	case a.noticeWake <- struct{}{}:
	default:
	}
	return nil
}

func (a *Actor) drainNotices() {
	a.noticeMu.Lock()
	notices := a.notices
	a.notices = nil
	a.noticeMu.Unlock()
	for _, notice := range notices {
		a.handle(notice)
	}
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
			a.drainNotices()
			if a.handle(msg) {
				return
			}
			resetTimer(idleTimer, actorIdleTimeout)
		case msg := <-a.realtime:
			a.drainNotices()
			if a.handle(msg) {
				return
			}
		case <-a.realtimeWake:
			a.drainNotices()
			a.flushMergedRealtime()
		case <-a.noticeWake:
			a.drainNotices()
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
	case notifyUserMessage:
		for id, client := range a.state.Clients {
			if client.UserID != m.UserID {
				continue
			}
			if m.Close {
				drainOutbound(client.Send)
			}
			sendOutbound(client.Send, Outbound{JSON: Envelope{Type: m.Type, Data: map[string]any{"role": m.Role}}})
			if m.Close {
				sendOutbound(client.Send, Outbound{Close: true})
				delete(a.state.Clients, id)
			}
		}
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
	currentRole := ""
	if client.Done != nil {
		if client.Account {
			role, banned, err := a.store.MemberRole(context.Background(), a.roomID, client.UserID)
			if err != nil || banned || role == "" {
				msg.Reply <- JoinResult{err: ErrRoomAccessRevoked}
				return
			}
			currentRole = role
		} else {
			role, kicked, err := a.store.GuestRole(context.Background(), a.roomID, client.UserID)
			if err != nil || kicked {
				msg.Reply <- JoinResult{err: ErrRoomAccessRevoked}
				return
			}
			currentRole = role
		}
	}
	if client.Account {
		for id, existing := range a.state.Clients {
			if existing.Account && existing.UserID == client.UserID {
				drainOutbound(existing.Send)
				sendOutbound(existing.Send, Outbound{JSON: Envelope{Type: "session.replaced"}})
				sendOutbound(existing.Send, Outbound{Close: true})
				delete(a.state.Clients, id)
			}
		}
	}
	client.PageID = normalizePageID(msg.PageID, a.state.Room.TotalPage)
	a.state.Clients[client.ID] = client
	resume, deltas := decideResume(a.state.Deltas, msg.LastRoomSeq, a.state.RoomSeq)
	online := len(a.state.Clients)
	members := a.state.OnlineMembers()
	result := JoinResult{Room: a.state.Room, Deltas: deltas, Resume: resume, ResumeSeq: msg.LastRoomSeq, Online: online, Members: members}
	if client.Done != nil {
		// Pin a durable read view at the actor sequence; build and send outside
		// the actor while later events wait in the bounded per-client queue.
		var snapshot *storage.ReadSnapshot
		var snapshotCtx context.Context
		var cancel context.CancelFunc
		if resume == "snapshot" {
			var err error
			snapshot, snapshotCtx, cancel, err = a.pinSnapshot()
			if err != nil {
				if client.Abort != nil {
					client.Abort()
				}
				result.InitStreamed = true
				msg.Reply <- result
				delete(a.state.Clients, client.ID)
				return
			}
		}
		out := client.Send
		if !sendOutbound(out, Outbound{JSON: Envelope{Type: "role.current", Data: map[string]any{"role": currentRole}}}) {
			if snapshot != nil {
				snapshot.Close()
				cancel()
				<-snapshotSlots
			}
			if client.Abort != nil {
				client.Abort()
			}
			result.InitStreamed = true
			msg.Reply <- result
			delete(a.state.Clients, client.ID)
			return
		}
		live := make(chan Outbound, cap(out))
		client.Send = live
		a.state.Clients[client.ID] = client
		streamResult := result
		snapshotSeq := a.state.RoomSeq
		var initialIDs []string
		var initialMaxLamport float64
		var clearBefore map[int]sceneOrderKey
		if snapshot != nil {
			pages := pageIDSet(initPageIDs(client.PageID, a.state.Room.TotalPage, a.cfg.InitPreloadPageCount))
			hiddenPaths := hiddenClearedPaths(a.state.Commands, a.state.ClearBefore)
			clearBefore = make(map[int]sceneOrderKey, len(a.state.ClearBefore))
			for page, watermark := range a.state.ClearBefore {
				clearBefore[page] = watermark
			}
			for _, cmd := range a.state.Commands {
				page, ok := cmd.PageID()
				if ok && pages[page] && commandVisibleAfterClear(cmd, clearBefore) && !isHiddenPathAppend(cmd, hiddenPaths) {
					initialIDs = append(initialIDs, cmd.ID())
				}
			}
			initialMaxLamport = maxCommandLamport(a.state.Commands)
		}
		go func() {
			if snapshot != nil {
				commands, err := snapshot.CommandsByID(snapshotCtx, initialIDs)
				snapshot.Close()
				cancel()
				if err == nil && len(commands) != len(initialIDs) {
					err = errors.New("snapshot missing selected commands")
				}
				if err != nil {
					<-snapshotSlots
					if client.Abort != nil {
						client.Abort()
					}
					return
				}
				room := streamResult.Room
				room.DurableSeq = snapshotSeq
				state := NewState(room, commands)
				state.ClearBefore = clearBefore
				streamResult.Init = a.builder.Init(state, client.PageID)
				streamResult.Init.Meta["maxLamport"] = initialMaxLamport
				<-snapshotSlots
			}
			sendInitStream(out, streamResult.Room.Name, client, streamResult, true)
			for {
				select {
				case event := <-live:
					if event.StreamReady != nil {
						select {
						case stream := <-event.StreamReady:
							if stream == nil {
								if client.Abort != nil {
									client.Abort()
								}
								return
							}
							sendPageChangeStreamWait(out, client.Abort, client.Done, *stream, true)
						case <-client.Done:
							return
						}
						continue
					}
					if event.Stream != nil {
						sendPageChangeStreamWait(out, client.Abort, client.Done, *event.Stream, true)
						continue
					}
					select {
					case out <- event:
					case <-client.Done:
						return
					}
				case <-client.Done:
					return
				}
			}
		}()
	} else if resume == "snapshot" {
		a.builder.SendLiveInitStream(client.Send, a.state, client, online, members)
	} else {
		SendInitStream(client.Send, a.state.Room.Name, client, result)
	}
	result.InitStreamed = true
	msg.Reply <- result
	a.broadcastExcept(client.ID, Envelope{Type: "online-count-change", Data: map[string]any{
		"onlineCount": len(a.state.Clients), "userId": client.UserID, "userName": client.UserName, "type": "join",
	}}, nil)
}

func decideResume(buffer *DeltaBuffer, last, head uint64) (string, []DeltaEvent) {
	deltas, ok := buffer.Since(last)
	resume := "snapshot"
	if last > 0 && last <= head {
		if last == head {
			resume = "current"
		} else if ok && len(deltas) > 0 && deltas[0].RoomSeq == last+1 && deltas[len(deltas)-1].RoomSeq == head {
			resume = "delta"
			for i, delta := range deltas {
				if delta.RoomSeq != last+1+uint64(i) {
					resume = "snapshot"
					break
				}
			}
		}
	}
	return resume, deltas
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
	client.PageID = normalizePageID(valueOr(msg.Request.PageID, client.PageID), a.state.Room.TotalPage)
	if msg.Request.NextPageID != nil {
		client.PageID = normalizePageID(*msg.Request.NextPageID, a.state.Room.TotalPage)
	}
	a.state.Clients[msg.ClientID] = client
	if client.Done != nil {
		snapshot, ctx, cancel, err := a.pinSnapshot()
		if err != nil {
			if client.Abort != nil {
				client.Abort()
			}
			return
		}
		ready := make(chan *InitStream, 1)
		if !sendOutbound(client.Send, Outbound{StreamReady: ready, Frozen: true}) {
			snapshot.Close()
			cancel()
			<-snapshotSlots
			if client.Abort != nil {
				client.Abort()
			}
			return
		}
		room := a.state.Room
		room.DurableSeq = a.state.RoomSeq
		request := msg.Request
		go func() {
			commands, err := readSnapshot(snapshot, ctx, cancel)
			if err != nil {
				<-snapshotSlots
				ready <- nil
				return
			}
			state := NewState(room, commands)
			stream := a.builder.PageChange(state, request)
			<-snapshotSlots
			ready <- &stream
		}()
	} else {
		stream := a.builder.PageChange(a.state, msg.Request)
		sendPageChangeStream(client.Send, client.Abort, stream)
	}
}

func (a *Actor) broadcastExcept(exclude ClientID, json any, binary []byte) {
	msg := sharedBroadcastOutbound(json, binary)
	for id, client := range a.state.Clients {
		if id == exclude {
			continue
		}
		if !sendOutbound(client.Send, msg) {
			a.metrics.SlowClients.Add(1)
			if client.Abort != nil {
				client.Abort()
			}
		}
	}
}

func (a *Actor) broadcastAll(json any, binary []byte) {
	msg := sharedBroadcastOutbound(json, binary)
	for _, client := range a.state.Clients {
		if !sendOutbound(client.Send, msg) {
			a.metrics.SlowClients.Add(1)
			if client.Abort != nil {
				client.Abort()
			}
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
