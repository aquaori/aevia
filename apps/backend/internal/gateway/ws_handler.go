package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"collaborative-whiteboard/apps/backend/internal/auth"
	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/room"
	"github.com/coder/websocket"
)

func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		fail(w, http.StatusServiceUnavailable, "Server is draining")
		return
	}
	if !s.originAllowed(r) {
		fail(w, http.StatusForbidden, "Origin is not allowed")
		return
	}
	token := wsProtocolToken(r)
	claims, err := s.verifySessionToken(token)
	if err != nil {
		fail(w, http.StatusUnauthorized, "Invalid token")
		return
	}
	roomData, exists, err := s.store.GetRoom(r.Context(), claims.RoomID)
	if err != nil || !exists || roomData.CreatedAt != claims.RoomCreatedAt {
		fail(w, http.StatusUnauthorized, "Invalid room session")
		return
	}
	actor, err := s.registry.Get(r.Context(), claims.RoomID)
	if err != nil {
		if errors.Is(err, room.ErrActorStopped) {
			// The room was evicted between lookup and start; the client's retry
			// will mint a fresh actor.
			fail(w, http.StatusServiceUnavailable, "Room is restarting, please retry")
			return
		}
		fail(w, http.StatusUnauthorized, "Room does not exist")
		return
	}
	ip := s.ipResolver.ClientIP(r)
	if !s.connectionLimit.Acquire(ip, claims.RoomID) {
		fail(w, http.StatusTooManyRequests, "Connection limit exceeded")
		return
	}
	acquiredConnection := true
	defer func() {
		if acquiredConnection {
			s.connectionLimit.Release(ip, claims.RoomID)
		}
	}()
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:    []string{token},
		OriginPatterns:  s.wsOriginPatterns(),
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(s.cfg.WSMaxPayloadBytes)

	client := newWSClient(conn, actor, claims, initialPageID(r), s.cfg)
	result, err := actor.Join(client.info(), client.pageID, lastRoomSeq(r))
	if err != nil {
		reason := "room busy"
		if errors.Is(err, room.ErrActorStopped) {
			reason = "room restarting"
		}
		_ = conn.Close(websocket.StatusTryAgainLater, reason)
		return
	}
	slog.Info("ws connected", "room", claims.RoomID, "user", claims.UserName, "userId", claims.UserID, "page", client.pageID)
	room.SendInitStream(client.send, roomData.Name, client.info(), result)
	client.run(r.Context())
	acquiredConnection = false
	s.connectionLimit.Release(ip, claims.RoomID)
}

func wsProtocolToken(r *http.Request) string {
	value := r.Header.Get("Sec-WebSocket-Protocol")
	if value == "" {
		return ""
	}
	return strings.TrimSpace(strings.Split(value, ",")[0])
}

func initialPageID(r *http.Request) int {
	pageID, err := strconv.Atoi(r.URL.Query().Get("pageId"))
	if err != nil || pageID < 0 {
		return 0
	}
	return pageID
}

func lastRoomSeq(r *http.Request) uint64 {
	value, err := strconv.ParseUint(r.URL.Query().Get("lastRoomSeq"), 10, 64)
	if err != nil {
		return 0
	}
	return value
}

type wsClient struct {
	conn        *websocket.Conn
	actor       *room.Actor
	claims      auth.Claims
	id          room.ClientID
	pageID      int
	send        chan room.Outbound
	limits      wsClientLimits
	events      *wsEventLimiter
	heartbeat   time.Duration
	pongTimeout time.Duration
}

func newWSClient(conn *websocket.Conn, actor *room.Actor, claims auth.Claims, pageID int, cfg config.Config) *wsClient {
	return &wsClient{
		conn: conn, actor: actor, claims: claims, pageID: pageID,
		id:     room.ClientID(randomID()),
		send:   make(chan room.Outbound, cfg.ConnectionSendMessages),
		events: newWSEventLimiter(cfg),
		limits: wsClientLimits{
			maxPointsPerUpdate:  cfg.WSMaxPointsPerUpdate,
			maxPointsPerCommand: cfg.WSMaxPointsPerCommand,
			maxBatchCommands:    cfg.WSMaxBatchCommands,
		},
		heartbeat:   cfg.WSHeartbeatInterval,
		pongTimeout: cfg.WSPongTimeout,
	}
}

func (c *wsClient) info() room.ClientInfo {
	return room.ClientInfo{
		ID: c.id, UserID: c.claims.UserID, UserName: c.claims.UserName,
		PageID: c.pageID, Send: c.send,
	}
}

func (c *wsClient) run(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer func() {
		c.actor.Leave(c.id)
		slog.Info("ws disconnected", "room", c.claims.RoomID, "user", c.claims.UserName, "userId", c.claims.UserID)
	}()
	defer c.conn.Close(websocket.StatusNormalClosure, "closed")

	done := make(chan struct{})
	go func() {
		defer close(done)
		c.writePump(ctx)
	}()
	c.readPump(ctx)
	cancel()
	<-done
}

func (c *wsClient) writePump(ctx context.Context) {
	ping := time.NewTicker(c.heartbeat)
	defer ping.Stop()
	for {
		select {
		case msg := <-c.send:
			if msg.Close {
				_ = c.conn.Close(websocket.StatusTryAgainLater, "resync required")
				return
			}
			if err := c.writeOutbound(ctx, msg); err != nil {
				// A failed write means the connection is gone; returning here
				// cancels readPump so the client is reaped instead of lingering.
				return
			}
		case <-ping.C:
			// Ping waits for the matching pong, so a timeout means the peer is
			// no longer responsive. Previously this error was discarded, which
			// left half-open connections alive indefinitely.
			pingCtx, cancel := context.WithTimeout(ctx, c.pongTimeout)
			err := c.conn.Ping(pingCtx)
			cancel()
			if err != nil {
				if ctx.Err() == nil {
					slog.Info("closing unresponsive websocket", "room", c.claims.RoomID, "userId", c.claims.UserID, "error", err)
				}
				_ = c.conn.Close(websocket.StatusPolicyViolation, "heartbeat timeout")
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func (c *wsClient) writeOutbound(ctx context.Context, msg room.Outbound) error {
	switch {
	case msg.Binary != nil:
		return c.conn.Write(ctx, websocket.MessageBinary, msg.Binary)
	case msg.Text != nil:
		return c.conn.Write(ctx, websocket.MessageText, msg.Text)
	case msg.JSON != nil:
		payload, err := json.Marshal(msg.JSON)
		if err != nil {
			slog.Warn("dropping unencodable outbound message", "room", c.claims.RoomID, "error", err)
			return nil
		}
		return c.conn.Write(ctx, websocket.MessageText, payload)
	default:
		return nil
	}
}

func (c *wsClient) readPump(ctx context.Context) {
	for {
		msgType, payload, err := c.conn.Read(ctx)
		if err != nil {
			return
		}
		switch msgType {
		case websocket.MessageBinary:
			handleBinaryClientMessage(c, payload)
		case websocket.MessageText:
			handleTextClientMessage(c, payload)
		}
	}
}
