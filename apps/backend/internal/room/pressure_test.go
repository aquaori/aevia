package room

import (
	"reflect"
	"testing"
	"time"
)

func pressureTestActor() *Actor {
	return &Actor{
		state:    State{Clients: map[ClientID]ClientInfo{}},
		inbox:    make(chan actorMessage, 10),
		realtime: make(chan actorMessage, 10),
	}
}

func TestChannelRatio(t *testing.T) {
	if got := channelRatio(3, 6); got != 0.5 {
		t.Fatalf("expected 0.5, got %f", got)
	}
	if got := channelRatio(0, 0); got != 0 {
		t.Fatalf("expected a zero-capacity channel ratio of 0, got %f", got)
	}
	if got := channelRatio(7, 0); got != 0 {
		t.Fatalf("expected a guard against division by zero, got %f", got)
	}
}

func TestCurrentPressureClassifiesQueueAndMetricPressure(t *testing.T) {
	now := time.Now()

	tests := []struct {
		name       string
		prepare    func(*Actor)
		wantLevel  pressureLevel
		wantReason string
	}{
		{
			name:       "stable room stays normal",
			prepare:    func(*Actor) {},
			wantLevel:  pressureNormal,
			wantReason: "stable",
		},
		{
			name: "elevated when the realtime queue passes 60%",
			prepare: func(actor *Actor) {
				for i := 0; i < 6; i++ {
					actor.realtime <- nil
				}
			},
			wantLevel:  pressureElevated,
			wantReason: "elevated-queue-pressure",
		},
		{
			name: "critical when the reliable queue passes 90%",
			prepare: func(actor *Actor) {
				for i := 0; i < 9; i++ {
					actor.inbox <- nil
				}
			},
			wantLevel:  pressureCritical,
			wantReason: "critical-queue-pressure",
		},
		{
			name: "critical after a reliable rejection",
			prepare: func(actor *Actor) {
				actor.pressureLastMetrics = actor.metrics.Snapshot()
				actor.metrics.ReliableRejected.Add(1)
			},
			wantLevel:  pressureCritical,
			wantReason: "critical-queue-pressure",
		},
		{
			name: "high after 64 realtime drops",
			prepare: func(actor *Actor) {
				actor.pressureLastMetrics = actor.metrics.Snapshot()
				actor.metrics.RealtimeDropped.Add(64)
			},
			wantLevel:  pressureHigh,
			wantReason: "high-queue-pressure",
		},
		{
			name: "elevated after the first realtime drop",
			prepare: func(actor *Actor) {
				actor.pressureLastMetrics = actor.metrics.Snapshot()
				actor.metrics.RealtimeDropped.Add(1)
			},
			wantLevel:  pressureElevated,
			wantReason: "elevated-queue-pressure",
		},
		{
			name: "critical when three clients are slow",
			prepare: func(actor *Actor) {
				actor.pressureLastMetrics = actor.metrics.Snapshot()
				actor.metrics.SlowClients.Add(3)
			},
			wantLevel:  pressureCritical,
			wantReason: "critical-queue-pressure",
		},
		{
			name: "high when a client send queue reaches 75%",
			prepare: func(actor *Actor) {
				send := make(chan Outbound, 4)
				for i := 0; i < 3; i++ {
					send <- Outbound{}
				}
				actor.state.Clients[ClientID("client-1")] = ClientInfo{ID: "client-1", Send: send}
			},
			wantLevel:  pressureHigh,
			wantReason: "high-queue-pressure",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			actor := pressureTestActor()
			test.prepare(actor)
			snapshot := actor.currentPressure(now)
			if snapshot.Level != test.wantLevel || snapshot.Reason != test.wantReason {
				t.Fatalf("expected %s/%s, got %s/%s",
					test.wantLevel, test.wantReason, snapshot.Level, snapshot.Reason)
			}
			if snapshot.SampledAt != now.UnixMilli() {
				t.Fatalf("expected sampledAt %d, got %d", now.UnixMilli(), snapshot.SampledAt)
			}
			if snapshot.Policy != policyForPressure(test.wantLevel) {
				t.Fatalf("expected the %s policy, got %+v", test.wantLevel, snapshot.Policy)
			}
		})
	}
}

func TestCurrentPressureReportsRecentDeltas(t *testing.T) {
	actor := pressureTestActor()
	actor.pressureLastMetrics = actor.metrics.Snapshot()
	actor.metrics.RealtimeDropped.Add(2)
	actor.metrics.RealtimeMerged.Add(3)
	actor.metrics.SlowClients.Add(1)
	actor.metrics.DBFailures.Add(4)

	snapshot := actor.currentPressure(time.Now())
	for key, want := range map[string]uint64{
		"realtimeDropped": 2,
		"realtimeMerged":  3,
		"slowClients":     1,
		"dbFailures":      4,
	} {
		if got, ok := snapshot.Recent[key].(uint64); !ok || got != want {
			t.Fatalf("expected recent[%s] = %d, got %v", key, want, snapshot.Recent[key])
		}
	}

	// Deltas are relative to the last broadcast, not absolute counters.
	actor.pressureLastMetrics = actor.metrics.Snapshot()
	if recent := actor.currentPressure(time.Now()).Recent; recent["realtimeDropped"] != uint64(0) {
		t.Fatalf("expected zero deltas after a snapshot, got %v", recent)
	}
}

func TestPolicyForPressureMapsEveryLevel(t *testing.T) {
	want := map[pressureLevel]pressurePolicy{
		pressureNormal:   {CursorMinIntervalMS: 16, UpdateMinIntervalMS: 16, UpdateMinPoints: 1, SampleMinDistancePX: 2, MaxUpdatePoints: 128},
		pressureElevated: {CursorMinIntervalMS: 50, UpdateMinIntervalMS: 33, UpdateMinPoints: 4, SampleMinDistancePX: 3, MaxUpdatePoints: 128},
		pressureHigh:     {CursorMinIntervalMS: 100, UpdateMinIntervalMS: 50, UpdateMinPoints: 8, SampleMinDistancePX: 4, MaxUpdatePoints: 96},
		pressureCritical: {CursorMinIntervalMS: 200, UpdateMinIntervalMS: 100, UpdateMinPoints: 16, SampleMinDistancePX: 6, MaxUpdatePoints: 64},
	}
	for level, expected := range want {
		if got := policyForPressure(level); got != expected {
			t.Fatalf("%s: expected %+v, got %+v", level, expected, got)
		}
	}
	// Unknown levels fall back to the least restrictive policy, never to zero
	// values that would stall the client.
	if got := policyForPressure(pressureLevel("mystery")); got != want[pressureNormal] {
		t.Fatalf("expected unknown levels to fall back to normal, got %+v", got)
	}
}

func TestPressureSnapshotToMapExposesWireShape(t *testing.T) {
	snapshot := pressureSnapshot{
		Level:              pressureHigh,
		Reason:             "high-queue-pressure",
		Clients:            3,
		ReliableQueueRatio: 0.25,
		RealtimeQueueRatio: 0.5,
		SendQueueRatio:     0.75,
		Recent:             map[string]any{"realtimeDropped": uint64(2)},
		Policy:             policyForPressure(pressureHigh),
		SampledAt:          1234,
	}
	payload := snapshot.toMap()
	if payload["level"] != "high" || payload["reason"] != "high-queue-pressure" {
		t.Fatalf("unexpected level/reason payload: %+v", payload)
	}
	if payload["clients"] != 3 || payload["sampledAt"] != int64(1234) {
		t.Fatalf("unexpected scalar payload: %+v", payload)
	}
	if payload["policy"] != snapshot.Policy {
		t.Fatalf("expected the policy to be embedded, got %+v", payload["policy"])
	}
	if !reflect.DeepEqual(payload["recent"], snapshot.Recent) {
		t.Fatalf("expected the recent metrics map to be embedded, got %+v", payload["recent"])
	}
}

func TestMaybeBroadcastPressureSamplesAndDebounces(t *testing.T) {
	actor := &Actor{
		state:            State{Clients: map[ClientID]ClientInfo{}},
		pressureLevel:    pressureNormal,
		pressureLastSent: time.Unix(100, 0),
	}
	now := time.Unix(100, 0).Add(100 * time.Millisecond)
	actor.metrics.ReliableRejected.Add(1)

	// The first call recomputes to critical, but it must not flap the level
	// within 250ms of the previous broadcast.
	actor.maybeBroadcastPressure(now)
	if actor.pressureLevel != pressureNormal {
		t.Fatalf("expected the debounce window to keep the level normal, got %s", actor.pressureLevel)
	}
	if !actor.pressureLastChecked.Equal(now) {
		t.Fatalf("expected the sample timestamp to advance, got %v", actor.pressureLastChecked)
	}

	// Inside the sample interval nothing is recomputed at all.
	actor.metrics.RealtimeDropped.Add(64)
	actor.maybeBroadcastPressure(now.Add(10 * time.Millisecond))
	if actor.pressureLevel != pressureNormal {
		t.Fatalf("expected the sample interval to throttle recomputation, got %s", actor.pressureLevel)
	}

	// Past both windows the critical level is broadcast and recorded.
	later := now.Add(400 * time.Millisecond)
	actor.maybeBroadcastPressure(later)
	if actor.pressureLevel != pressureCritical {
		t.Fatalf("expected a critical broadcast, got %s", actor.pressureLevel)
	}
	if !actor.pressureLastSent.Equal(later) {
		t.Fatalf("expected the broadcast timestamp to advance, got %v", actor.pressureLastSent)
	}
}
