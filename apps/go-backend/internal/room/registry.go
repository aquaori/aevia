package room

import (
	"context"
	"sync"

	"collaborative-whiteboard/apps/go-backend/internal/config"
	"collaborative-whiteboard/apps/go-backend/internal/storage"
)

type Registry struct {
	store  *storage.Store
	cfg    config.Config
	mu     sync.Mutex
	actors map[string]*Actor
}

func NewRegistry(store *storage.Store, cfg config.Config) *Registry {
	return &Registry{store: store, cfg: cfg, actors: make(map[string]*Actor)}
}

func (r *Registry) Get(ctx context.Context, roomID string) (*Actor, error) {
	r.mu.Lock()
	if actor := r.actors[roomID]; actor != nil {
		r.mu.Unlock()
		return actor, nil
	}
	r.mu.Unlock()

	actor, err := NewActor(ctx, r.store, r.cfg, roomID)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	if existing := r.actors[roomID]; existing != nil {
		r.mu.Unlock()
		return existing, nil
	}
	r.actors[roomID] = actor
	r.mu.Unlock()
	return actor, nil
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
