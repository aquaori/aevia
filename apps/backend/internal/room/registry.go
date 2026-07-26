package room

import (
	"context"
	"sync"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/storage"
)

type Registry struct {
	store  *storage.Store
	cfg    config.Config
	mu     sync.Mutex
	actors map[string]*Actor
}

func NewRegistry(store *storage.Store, cfg config.Config) *Registry {
	registry := &Registry{store: store, cfg: cfg, actors: make(map[string]*Actor)}
	// Fire-and-forget persistence failures have no caller to return to, so route
	// them to the owning room, which drops to read-only and tells its clients to
	// resync rather than serving state that is not durable.
	store.SetAsyncFailureHandler(registry.reportWriteFailure)
	return registry
}

func (r *Registry) reportWriteFailure(roomID string, err error) {
	if actor := r.lookup(roomID); actor != nil {
		actor.NotifyWriteFailure(err)
	}
}

func (r *Registry) Get(ctx context.Context, roomID string) (*Actor, error) {
	if actor := r.lookup(roomID); actor != nil {
		return actor, nil
	}

	actor, err := NewActor(ctx, r.store, r.cfg, roomID, r.remove)
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	// A concurrent caller may have installed a live actor while we were loading
	// state; prefer theirs and discard ours.
	if existing := r.actors[roomID]; existing != nil && !existing.Stopped() {
		r.mu.Unlock()
		actor.Shutdown(ctx)
		return existing, nil
	}
	if actor.Stopped() {
		// Evicted before it was ever published (possible only under an
		// absurdly short idle timeout); nothing to install.
		r.mu.Unlock()
		return nil, ErrActorStopped
	}
	r.actors[roomID] = actor
	r.mu.Unlock()
	return actor, nil
}

// lookup returns a live actor for roomID, clearing out one that has stopped.
func (r *Registry) lookup(roomID string) *Actor {
	r.mu.Lock()
	defer r.mu.Unlock()
	actor := r.actors[roomID]
	if actor == nil {
		return nil
	}
	if actor.Stopped() {
		delete(r.actors, roomID)
		return nil
	}
	return actor
}

// remove detaches a stopped actor from the registry. It is called from the
// actor's own goroutine as it exits, and only clears the entry when it is still
// the actor we own, so a replacement installed in the meantime survives.
func (r *Registry) remove(actor *Actor) {
	if actor == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.actors[actor.RoomID()] == actor {
		delete(r.actors, actor.RoomID())
	}
}

func (r *Registry) Shutdown(ctx context.Context) {
	r.mu.Lock()
	actors := make([]*Actor, 0, len(r.actors))
	for _, actor := range r.actors {
		actors = append(actors, actor)
	}
	r.mu.Unlock()
	for _, actor := range actors {
		actor.Shutdown(ctx)
	}
}

func (r *Registry) BeginDraining(reason string) {
	r.mu.Lock()
	actors := make([]*Actor, 0, len(r.actors))
	for _, actor := range r.actors {
		actors = append(actors, actor)
	}
	r.mu.Unlock()
	for _, actor := range actors {
		actor.BeginDraining(reason)
	}
}

func (r *Registry) Stats() map[string]MetricsSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	stats := make(map[string]MetricsSnapshot, len(r.actors))
	for roomID, actor := range r.actors {
		stats[roomID] = actor.Stats()
	}
	return stats
}
