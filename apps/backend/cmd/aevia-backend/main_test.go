package main

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
)

func TestStartPprofServer(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	if srv := startPprofServer(config.Config{}, logger); srv != nil {
		t.Fatal("expected nil pprof server when PprofAddr is empty")
	}

	srv := startPprofServer(config.Config{PprofAddr: "127.0.0.1:0"}, logger)
	if srv == nil {
		t.Fatal("expected pprof server when PprofAddr is configured")
	}
	req, _ := http.NewRequest(http.MethodGet, "/debug/pprof/cmdline", nil)
	mux, ok := srv.Handler.(*http.ServeMux)
	if !ok {
		t.Fatalf("expected *http.ServeMux handler, got %T", srv.Handler)
	}
	if _, pattern := mux.Handler(req); pattern == "" {
		t.Fatal("expected pprof handler route to be registered")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown pprof server: %v", err)
	}
}
