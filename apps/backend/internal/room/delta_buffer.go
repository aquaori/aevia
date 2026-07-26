package room

import (
	"sort"
	"time"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

type DeltaBuffer struct {
	ttl       time.Duration
	maxBytes  int
	events    []deltaEntry
	bytes     int
	lastPrune time.Time
}

type deltaEntry struct {
	event     DeltaEvent
	createdAt time.Time
	bytes     int
}

func NewDeltaBuffer(ttl time.Duration, maxBytes int) *DeltaBuffer {
	return &DeltaBuffer{ttl: ttl, maxBytes: maxBytes, lastPrune: time.Now()}
}

func (b *DeltaBuffer) Add(event DeltaEvent) {
	event = snapshotDeltaEvent(event)
	size := estimateDeltaSize(event)
	b.events = append(b.events, deltaEntry{event: event, createdAt: time.Now(), bytes: size})
	b.bytes += size
	// Byte pressure is corrected immediately; the TTL sweep is amortised because
	// it is O(len(events)) and Add sits on the broadcast hot path.
	b.trimBytes()
	b.pruneExpired(false)
}

func (b *DeltaBuffer) Since(roomSeq uint64) ([]DeltaEvent, bool) {
	b.pruneExpired(true)
	if len(b.events) == 0 {
		return nil, true
	}
	if roomSeq > 0 && b.events[0].event.RoomSeq > roomSeq+1 {
		return nil, false
	}
	out := make([]DeltaEvent, 0)
	for _, entry := range b.events {
		if entry.event.RoomSeq > roomSeq {
			out = append(out, entry.event)
		}
	}
	return out, true
}

// pruneExpired drops entries older than the TTL. Entries are appended in time
// order, so expiry is a prefix and can be found by binary search instead of a
// full rebuild. force skips the rate limit and is used on read paths.
func (b *DeltaBuffer) pruneExpired(force bool) {
	now := time.Now()
	if !force && now.Sub(b.lastPrune) < b.ttl/4 {
		return
	}
	b.lastPrune = now
	cutoff := now.Add(-b.ttl)
	drop := sort.Search(len(b.events), func(i int) bool {
		return !b.events[i].createdAt.Before(cutoff)
	})
	if drop == 0 {
		return
	}
	for _, entry := range b.events[:drop] {
		b.bytes -= entry.bytes
	}
	// Re-slice into a fresh backing array so the dropped entries (which hold
	// point slices) become collectable instead of being pinned by the old array.
	remaining := len(b.events) - drop
	kept := make([]deltaEntry, remaining, remaining+16)
	copy(kept, b.events[drop:])
	b.events = kept
	if b.bytes < 0 {
		b.bytes = 0
	}
}

func (b *DeltaBuffer) trimBytes() {
	dropped := 0
	for b.bytes > b.maxBytes && dropped < len(b.events) {
		b.bytes -= b.events[dropped].bytes
		dropped++
	}
	if dropped == 0 {
		return
	}
	remaining := len(b.events) - dropped
	kept := make([]deltaEntry, remaining, remaining+16)
	copy(kept, b.events[dropped:])
	b.events = kept
	if b.bytes < 0 {
		b.bytes = 0
	}
}

// estimateDeltaSize approximates the retained footprint of an event.
//
// This used to call fmt.Sprint on every value, which formatted whole point
// slices into throwaway strings purely to measure their length — on the
// broadcast hot path, for a buffer that only needs a rough byte budget. The
// sizes below are structural estimates instead: no allocation, no reflection.
func estimateDeltaSize(event DeltaEvent) int {
	size := len(event.Type) + len(event.Binary) + 64
	for key, value := range event.Data {
		size += len(key) + estimateValueSize(value)
	}
	return size
}

func estimateValueSize(value any) int {
	switch v := value.(type) {
	case nil:
		return 0
	case string:
		return len(v)
	case bool:
		return 1
	case int, int32, int64, uint32, uint64, float32, float64:
		return 8
	case []domain.Point:
		return len(v) * pointByteEstimate
	case []domain.FlatPoint:
		return len(v) * flatPointByteEstimate
	case domain.Command:
		return len(v.Points())*pointByteEstimate + commandOverheadEstimate
	case []any:
		size := 0
		for _, item := range v {
			size += estimateValueSize(item)
		}
		return size
	case map[string]any:
		size := 0
		for key, item := range v {
			size += len(key) + estimateValueSize(item)
		}
		return size
	default:
		return 16
	}
}

const (
	pointByteEstimate       = 32
	flatPointByteEstimate   = 64
	commandOverheadEstimate = 256
)
