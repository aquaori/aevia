package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"syscall"
	"time"

	"collaborative-whiteboard/apps/go-backend/internal/auth"
	"collaborative-whiteboard/apps/go-backend/internal/config"
	"collaborative-whiteboard/apps/go-backend/internal/console"
	"collaborative-whiteboard/apps/go-backend/internal/gateway"
	"collaborative-whiteboard/apps/go-backend/internal/room"
	"collaborative-whiteboard/apps/go-backend/internal/storage"
)

func main() {
	cfg := config.Load()
	logger := slog.New(console.NewHandler(os.Stdout, cfg.LogLevel))
	slog.SetDefault(logger)
	auth.ConfigureHashPool(cfg.HashPoolSize, cfg.HashQueueTimeout)

	store, err := storage.Open(cfg)
	if err != nil {
		logger.Error("open storage", "error", err)
		os.Exit(1)
	}

	if err := store.EnsureDefaultRoom(context.Background(), cfg.DefaultRoomID); err != nil {
		logger.Error("ensure default room", "error", err)
		os.Exit(1)
	}

	registry := room.NewRegistry(store, cfg)
	server := gateway.NewServer(cfg, store, registry)
	httpServer := &http.Server{
		Addr:              cfg.Addr(),
		Handler:           server.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       75 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pprofServer := startPprofServer(cfg, logger)

	listener, err := net.Listen("tcp", cfg.Addr())
	if err != nil {
		logger.Error("listen failed", "addr", cfg.Addr(), "error", err)
		os.Exit(1)
	}
	console.PrintStartupPanel(os.Stdout, cfg)

	go func() {
		logger.Info("backend started", "addr", cfg.Addr(), "db", cfg.DBPath)
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	server.BeginDraining()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if pprofServer != nil {
		_ = pprofServer.Shutdown(shutdownCtx)
	}
	_ = httpServer.Shutdown(shutdownCtx)
	registry.Shutdown(shutdownCtx)
	_ = store.Flush(shutdownCtx)
	_ = store.Close()
	logger.Info("backend stopped")
}

func startPprofServer(cfg config.Config, logger *slog.Logger) *http.Server {
	if cfg.PprofAddr == "" {
		return nil
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	server := &http.Server{
		Addr:              cfg.PprofAddr,
		Handler:           mux,
		ReadHeaderTimeout: 2 * time.Second,
	}
	go func() {
		logger.Info("pprof management server started", "addr", cfg.PprofAddr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("pprof management server stopped", "error", err)
		}
	}()
	return server
}
