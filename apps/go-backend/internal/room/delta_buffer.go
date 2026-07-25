package room

import (
	"fmt"
	"time"
)

type DeltaBuffer struct {
	ttl      time.Duration
	maxBytes int
	events   []deltaEntry
	bytes    int
}

type deltaEntry struct {
	event     DeltaEvent
	createdAt time.Time
	bytes     int
}

func NewDeltaBuffer(ttl time.Duration, maxBytes int) *DeltaBuffer {
	return &DeltaBuffer{ttl: ttl, maxBytes: maxBytes}
}

func (b *DeltaBuffer) Add(event DeltaEvent) {
	event = snapshotDeltaEvent(event)
	size := estimateDeltaSize(event)
	b.events = append(b.events, deltaEntry{event: event, createdAt: time.Now(), bytes: size})
	b.bytes += size
	b.prune()
}

func (b *DeltaBuffer) Since(roomSeq uint64) ([]DeltaEvent, bool) {
	b.prune()
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

func (b *DeltaBuffer) prune() {
	cutoff := time.Now().Add(-b.ttl)
	kept := b.events[:0]
	b.bytes = 0
	for _, entry := range b.events {
		if entry.createdAt.Before(cutoff) {
			continue
		}
		kept = append(kept, entry)
		b.bytes += entry.bytes
	}
	b.events = kept
	for b.bytes > b.maxBytes && len(b.events) > 0 {
		b.bytes -= b.events[0].bytes
		b.events = b.events[1:]
	}
}

func estimateDeltaSize(event DeltaEvent) int {
	size := len(event.Type) + len(event.Binary) + 64
	for key, value := range event.Data {
		size += len(key) + len(anyString(value))
	}
	return size
}

func anyString(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}
