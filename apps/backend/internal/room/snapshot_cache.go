package room

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

const maxInitCacheEntries = 16

type initCacheKey struct {
	roomID       string
	pageID       int
	totalPage    int
	roomSeq      uint64
	preloadPages int
	clearSig     string
}

type initCacheEntry struct {
	key             initCacheKey
	snapshotVersion int
	maxLamport      any
	metaBase        map[string]any
	renderChunks    []RenderChunk
	commandChunks   []CommandChunk
}

type initSnapshotCache struct {
	mu      sync.Mutex
	entries map[initCacheKey]*initCacheEntry
	order   []initCacheKey
}

func newInitSnapshotCache() *initSnapshotCache {
	return &initSnapshotCache{
		entries: make(map[initCacheKey]*initCacheEntry),
	}
}

func clearBeforeSignature(clearBefore map[int]sceneOrderKey) string {
	if len(clearBefore) == 0 {
		return ""
	}
	pages := make([]int, 0, len(clearBefore))
	for page := range clearBefore {
		pages = append(pages, page)
	}
	sort.Ints(pages)
	var b strings.Builder
	for i, page := range pages {
		if i > 0 {
			b.WriteByte(';')
		}
		key := clearBefore[page]
		fmt.Fprintf(&b, "%d:%.17g:%s:%d:%d", page, key.Lamport, key.OpID, key.SourceIndex, key.SubIndex)
	}
	return b.String()
}

func (c *initSnapshotCache) get(key initCacheKey) (InitStream, bool) {
	if c == nil || key.roomID == "" || key.roomSeq == 0 {
		return InitStream{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return InitStream{}, false
	}
	// Promote key in LRU order.
	for i, existing := range c.order {
		if existing == key {
			c.order = append(append(c.order[:i], c.order[i+1:]...), key)
			break
		}
	}
	meta := make(map[string]any, len(entry.metaBase)+1)
	for k, v := range entry.metaBase {
		meta[k] = v
	}
	if entry.maxLamport != nil {
		meta["maxLamport"] = entry.maxLamport
	}
	chunks := entry.commandChunks
	return InitStream{
		SnapshotVersion: entry.snapshotVersion,
		Meta:            meta,
		RenderChunks:    entry.renderChunks,
		CommandChunks:   chunks,
		prepareCommands: func() []CommandChunk {
			return chunks
		},
	}, true
}

func (c *initSnapshotCache) put(key initCacheKey, stream InitStream) InitStream {
	if c == nil || key.roomID == "" || key.roomSeq == 0 {
		return stream
	}
	// Pre-materialize and encode command chunks once while caching so subsequent
	// joiners share frozen JSON payloads without rebuilding or marshaling.
	chunks := stream.CommandChunks
	if chunks == nil && stream.prepareCommands != nil {
		chunks = stream.prepareCommands()
	}
	stream.CommandChunks = chunks
	stream.prepareCommands = func() []CommandChunk {
		return chunks
	}
	metaBase := make(map[string]any, len(stream.Meta))
	for k, v := range stream.Meta {
		metaBase[k] = v
	}
	entry := &initCacheEntry{
		key:             key,
		snapshotVersion: stream.SnapshotVersion,
		maxLamport:      stream.Meta["maxLamport"],
		metaBase:        metaBase,
		renderChunks:    stream.RenderChunks,
		commandChunks:   chunks,
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.entries[key]; exists {
		c.entries[key] = entry
		return stream
	}
	// Replace any stale sequence entry for the same room+page immediately to cap memory.
	kept := c.order[:0]
	for _, existing := range c.order {
		if existing.roomID == key.roomID && existing.pageID == key.pageID {
			delete(c.entries, existing)
			continue
		}
		kept = append(kept, existing)
	}
	c.order = kept
	for len(c.order) >= maxInitCacheEntries {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.entries, oldest)
	}
	c.entries[key] = entry
	c.order = append(c.order, key)
	return stream
}
