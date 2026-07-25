package room

import "sync/atomic"

type Metrics struct {
	ReliableRejected atomic.Uint64
	RealtimeDropped  atomic.Uint64
	RealtimeMerged   atomic.Uint64
	SlowClients      atomic.Uint64
	DBFailures       atomic.Uint64
	Commands         atomic.Uint64
	Deltas           atomic.Uint64
}

type MetricsSnapshot struct {
	ReliableRejected uint64 `json:"reliableRejected"`
	RealtimeDropped  uint64 `json:"realtimeDropped"`
	RealtimeMerged   uint64 `json:"realtimeMerged"`
	SlowClients      uint64 `json:"slowClients"`
	DBFailures       uint64 `json:"dbFailures"`
	Commands         uint64 `json:"commands"`
	Deltas           uint64 `json:"deltas"`
}

func (m *Metrics) Snapshot() MetricsSnapshot {
	return MetricsSnapshot{
		ReliableRejected: m.ReliableRejected.Load(),
		RealtimeDropped:  m.RealtimeDropped.Load(),
		RealtimeMerged:   m.RealtimeMerged.Load(),
		SlowClients:      m.SlowClients.Load(),
		DBFailures:       m.DBFailures.Load(),
		Commands:         m.Commands.Load(),
		Deltas:           m.Deltas.Load(),
	}
}
