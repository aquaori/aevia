package room

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

func makeV2PathOp(opID, elementID, kind string, lamport float64, sourceStart int, points []domain.Point) domain.Command {
	rawPoints := make([]any, 0, len(points))
	for _, p := range points {
		rawPoints = append(rawPoints, map[string]any{"x": p.X, "y": p.Y, "p": p.P, "lamport": p.Lamport})
	}
	payload := map[string]any{"points": rawPoints}
	if kind == "element.create" {
		payload["descriptor"] = map[string]any{
			"elementKind": "path",
			"recipeId":    "stroke",
			"toolId":      "pen",
			"style":       map[string]any{"color": "#111111", "size": 4.0},
		}
	} else {
		payload["sourceStart"] = float64(sourceStart)
	}
	return domain.NewCommand(map[string]any{
		"id":      opID,
		"type":    "scene-op",
		"userId":  "user-1",
		"pageId":  0,
		"lamport": lamport,
		"sceneOperation": map[string]any{
			"schemaVersion":  float64(2),
			"opId":           opID,
			"elementId":      elementID,
			"actorId":        "user-1",
			"roomId":         "room-causal",
			"pageId":         0,
			"lamport":        lamport,
			"historyGroupId": "hg-" + elementID,
			"kind":           kind,
			"payload":        payload,
		},
	})
}

func makeV2TextPatchOp(opID, elementID string, lamport float64, grapheme string) domain.Command {
	return domain.NewCommand(map[string]any{
		"id":      opID,
		"type":    "scene-op",
		"userId":  "user-1",
		"pageId":  0,
		"lamport": lamport,
		"sceneOperation": map[string]any{
			"schemaVersion":  float64(2),
			"opId":           opID,
			"elementId":      elementID,
			"actorId":        "user-1",
			"roomId":         "room-causal",
			"pageId":         0,
			"lamport":        lamport,
			"historyGroupId": "hg-" + opID,
			"kind":           "text.patch",
			"payload": map[string]any{
				"patches": []any{
					map[string]any{"type": "insert", "charId": opID + "-c1", "afterId": nil, "grapheme": grapheme},
				},
			},
		},
	})
}

func TestPagePointIndexProjectsOutOfOrderAppendWhenCreateArrivesLater(t *testing.T) {
	state := NewState(domain.Room{RoomID: "room-causal", TotalPage: 2}, nil)

	// Out-of-order live upsert: append arrives before its matching element.create (H49/H50).
	appendEarly := makeV2PathOp("op-append-1", "stroke-ooo", "element.append", 2, 1, []domain.Point{
		{X: 0.3, Y: 0.4, P: 0.5, Lamport: 2},
		{X: 0.4, Y: 0.5, P: 0.5, Lamport: 3},
	})
	state.UpsertCommand(appendEarly)

	if pts := state.Index.PagePoints([]int{0}); len(pts) != 0 {
		t.Fatalf("expected 0 projected points before create arrives, got %d", len(pts))
	}
	diag := state.CausalDiagnostics()
	if diag.PendingPathFragments != 1 || len(diag.OrphanElementIDs) != 1 || diag.OrphanElementIDs[0] != "stroke-ooo" {
		t.Fatalf("unexpected causal diagnostics while orphan pending: %+v", diag)
	}

	// Matching element.create arrives subsequently; queued append must project cleanly.
	createLater := makeV2PathOp("op-create-1", "stroke-ooo", "element.create", 1, 0, []domain.Point{
		{X: 0.1, Y: 0.2, P: 0.5, Lamport: 1},
	})
	state.UpsertCommand(createLater)

	pts := state.Index.PagePoints([]int{0})
	if len(pts) != 3 {
		t.Fatalf("expected all 3 points after late create resolves orphan append, got %d", len(pts))
	}
	if pts[0].OrderOpID != "op-create-1" || pts[1].OrderOpID != "op-append-1" || pts[1].PointIndex != 1 {
		t.Fatalf("unexpected projected order after resolution: %+v", pts)
	}
	afterDiag := state.CausalDiagnostics()
	if afterDiag.PendingPathFragments != 0 || len(afterDiag.OrphanElementIDs) != 0 {
		t.Fatalf("expected pending causal diagnostics to clear, got %+v", afterDiag)
	}
}

func TestPagePointIndexCapsOrphanPendingFragmentsAndCleansOnClear(t *testing.T) {
	idx := NewPagePointIndex(nil)
	for n := 0; n < maxPendingOrphansPerElement+16; n++ {
		idx.Upsert(makeV2PathOp(
			fmt.Sprintf("orphan-op-%d", n),
			"stroke-overflow",
			"element.append",
			float64(n+1),
			n,
			[]domain.Point{{X: 0.1, Y: 0.1, P: 0.5, Lamport: float64(n + 1)}},
		))
	}
	if idx.PendingFragmentCount() != maxPendingOrphansPerElement {
		t.Fatalf("expected pending count capped at %d, got %d", maxPendingOrphansPerElement, idx.PendingFragmentCount())
	}
	if idx.DroppedOrphanCount() != 16 {
		t.Fatalf("expected 16 overflowed orphan fragments counted, got %d", idx.DroppedOrphanCount())
	}

	// ClearPage must clean pending orphans even when the page has no projected blocks yet.
	idx.ClearPage(0)
	if idx.PendingFragmentCount() != 0 || len(idx.QuarantinedElementIDs()) != 0 {
		t.Fatalf("expected ClearPage to purge pending orphans, got count=%d ids=%v", idx.PendingFragmentCount(), idx.QuarantinedElementIDs())
	}
}

func TestStateCausalDiagnosticsTracksOrphanTextPatchWithoutCreate(t *testing.T) {
	state := NewState(domain.Room{RoomID: "room-causal", TotalPage: 1}, nil)
	state.UpsertCommand(makeV2TextPatchOp("op-txt-patch", "txt-orphan", 2, "H"))

	diag := state.CausalDiagnostics()
	if diag.PendingTextOps != 1 || len(diag.OrphanElementIDs) != 1 || diag.OrphanElementIDs[0] != "txt-orphan" {
		t.Fatalf("expected orphan text op to be surfaced in diagnostics, got %+v", diag)
	}

	// Late create resolves orphan status.
	state.UpsertCommand(domain.NewCommand(map[string]any{
		"id":      "op-txt-create",
		"type":    "scene-op",
		"userId":  "user-1",
		"pageId":  0,
		"lamport": 1.0,
		"sceneOperation": map[string]any{
			"schemaVersion":  float64(2),
			"opId":           "op-txt-create",
			"elementId":      "txt-orphan",
			"actorId":        "user-1",
			"roomId":         "room-causal",
			"pageId":         0,
			"lamport":        1.0,
			"historyGroupId": "hg-txt-create",
			"kind":           "element.create",
			"payload": map[string]any{
				"descriptor": map[string]any{
					"elementKind": "text",
					"recipeId":    "glyph",
					"toolId":      "text",
					"style":       map[string]any{"color": "#000000", "size": 16.0},
				},
			},
		},
	}))

	resolved := state.CausalDiagnostics()
	if resolved.PendingTextOps != 0 || len(resolved.OrphanElementIDs) != 0 {
		t.Fatalf("expected resolved diagnostics after create, got %+v", resolved)
	}
}

func TestActorSlowReaderIsolationAndCausalDiagnosticsUnderLiveTraffic(t *testing.T) {
	store, _, actor := newRoomActorTestHarness(t, "room-backpressure")
	if err := store.CreateGuest(context.Background(), "room-backpressure", "u-slow", "editor"); err != nil {
		t.Fatalf("create slow guest: %v", err)
	}
	if err := store.CreateGuest(context.Background(), "room-backpressure", "u-healthy", "editor"); err != nil {
		t.Fatalf("create healthy guest: %v", err)
	}

	// cSlow has a tiny send queue (cap 2) and never drains, plus Done + Abort tracking.
	slowSend := make(chan Outbound, 2)
	slowDone := make(chan struct{})
	var slowAborted atomic.Bool
	if _, err := actor.Join(ClientInfo{
		ID: "c-slow", UserID: "u-slow", UserName: "SlowUser", PageID: 0,
		Send: slowSend,
		Done: slowDone,
		Abort: func() {
			if slowAborted.CompareAndSwap(false, true) {
				close(slowDone)
			}
		},
	}, 0, 0); err != nil {
		t.Fatalf("join slow client: %v", err)
	}

	// Healthy peer with normal send buffer actively consumes all live broadcasts.
	healthySend := make(chan Outbound, 64)
	if _, err := actor.Join(ClientInfo{ID: "c-healthy", UserID: "u-healthy", UserName: "HealthyUser", PageID: 0, Send: healthySend}, 0, 0); err != nil {
		t.Fatalf("join healthy client: %v", err)
	}
	defer actor.Leave("c-healthy")
	// Drain healthy init burst.
	drainMessages(healthySend, 8, 200*time.Millisecond)

	// Publish out-of-order orphan append then matching create alongside enough pushes to overflow c-slow.
	appendPayload := map[string]any{
		"cmd": map[string]any{
			"id":      "live-append-first",
			"type":    "scene-op",
			"userId":  "u-healthy",
			"pageId":  0,
			"lamport": 2.0,
			"sceneOperation": map[string]any{
				"schemaVersion":  float64(2),
				"opId":           "live-append-first",
				"elementId":      "stroke-live-ooo",
				"actorId":        "u-healthy",
				"roomId":         "room-backpressure",
				"pageId":         0,
				"lamport":        2.0,
				"historyGroupId": "hg-live-ooo",
				"kind":           "element.append",
				"payload": map[string]any{
					"sourceStart": float64(1),
					"points":      []any{map[string]any{"x": 0.4, "y": 0.4, "p": 0.5, "lamport": 2.0}},
				},
			},
		},
	}
	if err := actor.Event("c-healthy", "push-cmd", appendPayload, false); err != nil {
		t.Fatalf("push out-of-order append: %v", err)
	}
	diagMid, err := actor.CausalDiagnostics()
	if err != nil || diagMid.PendingPathFragments != 1 {
		t.Fatalf("expected 1 pending fragment in live actor diagnostics, got %+v err=%v", diagMid, err)
	}

	// Flood more live events while slowSend stays full; healthy client must receive all of them and slow client must abort.
	for i := 0; i < 6; i++ {
		opID := fmt.Sprintf("live-burst-%d", i)
		payload := map[string]any{
			"cmd": map[string]any{
				"id":      opID,
				"type":    "scene-op",
				"userId":  "u-healthy",
				"pageId":  0,
				"lamport": float64(10 + i),
				"sceneOperation": map[string]any{
					"schemaVersion":  float64(2),
					"opId":           opID,
					"elementId":      opID,
					"actorId":        "u-healthy",
					"roomId":         "room-backpressure",
					"pageId":         0,
					"lamport":        float64(10 + i),
					"historyGroupId": "hg-" + opID,
					"kind":           "element.create",
					"payload": map[string]any{
						"descriptor": map[string]any{
							"elementKind": "path", "recipeId": "stroke", "toolId": "pen",
							"style": map[string]any{"color": "#000000", "size": 3.0},
						},
						"points": []any{map[string]any{"x": 0.2, "y": 0.2, "p": 0.5, "lamport": float64(10 + i)}},
					},
				},
			},
		}
		if err := actor.Event("c-healthy", "push-cmd", payload, false); err != nil {
			t.Fatalf("push burst %d: %v", i, err)
		}
	}

	// Expect healthy client got acks for all 7 pushes without blocking on slow client.
	msgs := drainMessages(healthySend, 7, 500*time.Millisecond)
	if len(msgs) < 7 {
		t.Fatalf("expected healthy client to receive all 7 acks without stalling, got %d", len(msgs))
	}
	if !slowAborted.Load() {
		t.Fatal("expected slow client Abort to be invoked on outbound overflow")
	}
	if stats := actor.Stats(); stats.SlowClients == 0 {
		t.Fatalf("expected SlowClients > 0 metric, got %+v", stats)
	}
}
