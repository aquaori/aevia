package gateway

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"collaborative-whiteboard/apps/go-backend/internal/auth"
	"collaborative-whiteboard/apps/go-backend/internal/config"
	"collaborative-whiteboard/apps/go-backend/internal/room"
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
		fail(w, http.StatusUnauthorized, "Room does not exist")
		return
	}
	ip := clientIP(r)
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
	client.limits = wsClientLimits{
		maxPointsPerUpdate:  s.cfg.WSMaxPointsPerUpdate,
		maxPointsPerCommand: s.cfg.WSMaxPointsPerCommand,
		maxBatchCommands:    s.cfg.WSMaxBatchCommands,
	}
	result, err := actor.Join(client.info(), client.pageID, lastRoomSeq(r))
	if err != nil {
		_ = conn.Close(websocket.StatusTryAgainLater, "room busy")
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
	conn   *websocket.Conn
	actor  *room.Actor
	claims auth.Claims
	id     room.ClientID
	pageID int
	send   chan room.Outbound
	limits wsClientLimits
	events *wsEventLimiter
}

func newWSClient(conn *websocket.Conn, actor *room.Actor, claims auth.Claims, pageID int, cfg config.Config) *wsClient {
	return &wsClient{
		conn: conn, actor: actor, claims: claims, pageID: pageID,
		id:     room.ClientID(randomID()),
		send:   make(chan room.Outbound, cfg.ConnectionSendMessages),
		events: newWSEventLimiter(cfg),
		limits: wsClientLimits{
			maxPointsPerUpdate:  2000,
			maxPointsPerCommand: 20000,
			maxBatchCommands:    200,
		},
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
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case msg := <-c.send:
			if msg.Close {
				_ = c.conn.Close(websocket.StatusTryAgainLater, "resync required")
				return
			}
			if msg.Binary != nil {
				_ = c.conn.Write(ctx, websocket.MessageBinary, msg.Binary)
				continue
			}
			if msg.Text != nil {
				_ = c.conn.Write(ctx, websocket.MessageText, msg.Text)
				continue
			}
			if msg.JSON != nil {
				payload, _ := json.Marshal(msg.JSON)
				_ = c.conn.Write(ctx, websocket.MessageText, payload)
			}
		case <-ping.C:
			pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			_ = c.conn.Ping(pingCtx)
			cancel()
		case <-ctx.Done():
			return
		}
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
