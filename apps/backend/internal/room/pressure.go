package room

import "time"

type pressureLevel string

const (
	pressureNormal   pressureLevel = "normal"
	pressureElevated pressureLevel = "elevated"
	pressureHigh     pressureLevel = "high"
	pressureCritical pressureLevel = "critical"
)

type pressurePolicy struct {
	CursorMinIntervalMS int `json:"cursorMinIntervalMs"`
	UpdateMinIntervalMS int `json:"updateMinIntervalMs"`
	UpdateMinPoints     int `json:"updateMinPoints"`
	SampleMinDistancePX int `json:"sampleMinDistancePx"`
	MaxUpdatePoints     int `json:"maxUpdatePoints"`
}

type pressureSnapshot struct {
	Level              pressureLevel  `json:"level"`
	Reason             string         `json:"reason"`
	Clients            int            `json:"clients"`
	ReliableQueueRatio float64        `json:"reliableQueueRatio"`
	RealtimeQueueRatio float64        `json:"realtimeQueueRatio"`
	SendQueueRatio     float64        `json:"sendQueueRatio"`
	Recent             map[string]any `json:"recent"`
	Policy             pressurePolicy `json:"policy"`
	SampledAt          int64          `json:"sampledAt"`
}

// pressureSampleInterval bounds how often pressure is recomputed. This runs
// after every handled message, and sampling walks every client's send queue, so
// an unthrottled check cost O(clients) per message (up to 1000 per room).
const pressureSampleInterval = 100 * time.Millisecond

func (a *Actor) maybeBroadcastPressure(now time.Time) {
	if now.Sub(a.pressureLastChecked) < pressureSampleInterval {
		return
	}
	a.pressureLastChecked = now

	snapshot := a.currentPressure(now)
	changed := snapshot.Level != a.pressureLevel
	shouldRefresh := snapshot.Level != pressureNormal && now.Sub(a.pressureLastSent) >= 2*time.Second
	shouldRecover := changed && snapshot.Level == pressureNormal && now.Sub(a.pressureLastSent) >= 250*time.Millisecond
	if !changed && !shouldRefresh {
		return
	}
	if !shouldRecover && changed && now.Sub(a.pressureLastSent) < 250*time.Millisecond {
		return
	}

	a.pressureLevel = snapshot.Level
	a.pressureLastSent = now
	a.pressureLastMetrics = a.metrics.Snapshot()
	a.broadcastAll(Envelope{Type: "server-pressure", Data: snapshot.toMap()}, nil)
}

func (a *Actor) currentPressure(now time.Time) pressureSnapshot {
	metrics := a.metrics.Snapshot()
	recentReliableRejected := metrics.ReliableRejected - a.pressureLastMetrics.ReliableRejected
	recentRealtimeDropped := metrics.RealtimeDropped - a.pressureLastMetrics.RealtimeDropped
	recentRealtimeMerged := metrics.RealtimeMerged - a.pressureLastMetrics.RealtimeMerged
	recentSlowClients := metrics.SlowClients - a.pressureLastMetrics.SlowClients
	recentDBFailures := metrics.DBFailures - a.pressureLastMetrics.DBFailures

	reliableRatio := channelRatio(len(a.inbox), cap(a.inbox))
	realtimeRatio := channelRatio(len(a.realtime), cap(a.realtime))
	sendRatio := a.maxClientSendQueueRatio()

	level := pressureNormal
	reason := "stable"
	switch {
	case reliableRatio >= 0.90 || sendRatio >= 0.90 || recentSlowClients >= 3 || recentReliableRejected > 0:
		level = pressureCritical
		reason = "critical-queue-pressure"
	case reliableRatio >= 0.75 || realtimeRatio >= 0.85 || sendRatio >= 0.75 || recentRealtimeDropped >= 64 || recentSlowClients > 0:
		level = pressureHigh
		reason = "high-queue-pressure"
	case reliableRatio >= 0.50 || realtimeRatio >= 0.60 || sendRatio >= 0.50 || recentRealtimeDropped > 0 || recentRealtimeMerged >= 32:
		level = pressureElevated
		reason = "elevated-queue-pressure"
	}

	return pressureSnapshot{
		Level:              level,
		Reason:             reason,
		Clients:            len(a.state.Clients),
		ReliableQueueRatio: reliableRatio,
		RealtimeQueueRatio: realtimeRatio,
		SendQueueRatio:     sendRatio,
		Recent: map[string]any{
			"reliableRejected": recentReliableRejected,
			"realtimeDropped":  recentRealtimeDropped,
			"realtimeMerged":   recentRealtimeMerged,
			"slowClients":      recentSlowClients,
			"dbFailures":       recentDBFailures,
		},
		Policy:    policyForPressure(level),
		SampledAt: now.UnixMilli(),
	}
}

func (a *Actor) maxClientSendQueueRatio() float64 {
	maxRatio := 0.0
	for _, client := range a.state.Clients {
		ratio := channelRatio(len(client.Send), cap(client.Send))
		if ratio > maxRatio {
			maxRatio = ratio
		}
	}
	return maxRatio
}

func channelRatio(length int, capacity int) float64 {
	if capacity <= 0 {
		return 0
	}
	return float64(length) / float64(capacity)
}

func policyForPressure(level pressureLevel) pressurePolicy {
	switch level {
	case pressureCritical:
		return pressurePolicy{CursorMinIntervalMS: 200, UpdateMinIntervalMS: 100, UpdateMinPoints: 16, SampleMinDistancePX: 6, MaxUpdatePoints: 64}
	case pressureHigh:
		return pressurePolicy{CursorMinIntervalMS: 100, UpdateMinIntervalMS: 50, UpdateMinPoints: 8, SampleMinDistancePX: 4, MaxUpdatePoints: 96}
	case pressureElevated:
		return pressurePolicy{CursorMinIntervalMS: 50, UpdateMinIntervalMS: 33, UpdateMinPoints: 4, SampleMinDistancePX: 3, MaxUpdatePoints: 128}
	default:
		return pressurePolicy{CursorMinIntervalMS: 16, UpdateMinIntervalMS: 16, UpdateMinPoints: 1, SampleMinDistancePX: 2, MaxUpdatePoints: 128}
	}
}

func (s pressureSnapshot) toMap() map[string]any {
	return map[string]any{
		"level":              string(s.Level),
		"reason":             s.Reason,
		"clients":            s.Clients,
		"reliableQueueRatio": s.ReliableQueueRatio,
		"realtimeQueueRatio": s.RealtimeQueueRatio,
		"sendQueueRatio":     s.SendQueueRatio,
		"recent":             s.Recent,
		"policy":             s.Policy,
		"sampledAt":          s.SampledAt,
	}
}
