package console

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func fixedRecord(level slog.Level, message string) slog.Record {
	record := slog.NewRecord(time.Date(2026, 3, 4, 12, 34, 56, 0, time.UTC), level, message, 0)
	return record
}

func TestHandlerWritesLevelAndMessage(t *testing.T) {
	var output bytes.Buffer
	handler := NewHandler(&output, slog.LevelInfo)

	ctx := context.Background()
	if !handler.Enabled(ctx, slog.LevelInfo) {
		t.Fatal("expected info to be enabled at the info threshold")
	}
	if handler.Enabled(ctx, slog.LevelDebug) {
		t.Fatal("expected debug to be filtered at the info threshold")
	}

	if err := handler.Handle(ctx, fixedRecord(slog.LevelInfo, "server started")); err != nil {
		t.Fatalf("handle: %v", err)
	}

	want := dim("12:34:56") + " " + cyan("INFO ") + " server started\n"
	if got := output.String(); got != want {
		t.Fatalf("unexpected log line:\n got %q\nwant %q", got, want)
	}
}

func TestHandlerFormatsAndQuotesAttributes(t *testing.T) {
	var output bytes.Buffer
	handler := NewHandler(&output, slog.LevelDebug)

	record := fixedRecord(slog.LevelWarn, "join rejected")
	record.AddAttrs(
		slog.String("plain", "value"),
		slog.String("spaced", "two words"),
		slog.String("empty", ""),
		slog.Int("attempts", 3),
		slog.Duration("took", 1500*time.Millisecond),
		slog.Time("at", time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)),
	)
	if err := handler.Handle(context.Background(), record); err != nil {
		t.Fatalf("handle: %v", err)
	}

	line := output.String()
	if !strings.Contains(line, yellow("WARN ")) {
		t.Fatalf("expected a warn level label, got %q", line)
	}
	for _, fragment := range []string{
		"plain=value",
		`spaced="two words"`,
		`empty=""`,
		"attempts=3",
		"took=1.5s",
		"at=2026-01-02T03:04:05Z",
	} {
		if !strings.Contains(line, fragment) {
			t.Fatalf("expected %q in %q", fragment, line)
		}
	}
}

func TestHandlerWithAttrsAndGroups(t *testing.T) {
	var output bytes.Buffer
	base := NewHandler(&output, slog.LevelInfo)
	scoped := base.WithAttrs([]slog.Attr{slog.String("room", "room-1")})

	if got := base.WithGroup("group"); got != base {
		t.Fatal("expected WithGroup to be a no-op that preserves the handler")
	}

	record := fixedRecord(slog.LevelInfo, "command accepted")
	record.AddAttrs(slog.Int("lamport", 7))
	if err := scoped.Handle(context.Background(), record); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if !strings.Contains(output.String(), "room=room-1 lamport=7") {
		t.Fatalf("expected scoped and record attributes, got %q", output.String())
	}

	// WithAttrs must not mutate the handler it was derived from.
	output.Reset()
	if err := base.Handle(context.Background(), fixedRecord(slog.LevelInfo, "plain")); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if strings.Contains(output.String(), "room=room-1") {
		t.Fatalf("expected the base handler to stay unscoped, got %q", output.String())
	}
}

func TestLevelLabelsCoverEveryLevel(t *testing.T) {
	tests := []struct {
		level slog.Level
		label string
	}{
		{slog.LevelDebug, dim("DEBUG")},
		{slog.LevelInfo, cyan("INFO ")},
		{slog.LevelWarn, yellow("WARN ")},
		{slog.LevelError, red("ERROR")},
	}
	for _, test := range tests {
		t.Run(test.level.String(), func(t *testing.T) {
			var output bytes.Buffer
			// The level here is below the handler threshold on purpose: Handle
			// itself must be callable directly (slog filters via Enabled).
			handler := NewHandler(&output, slog.LevelError)
			if err := handler.Handle(context.Background(), fixedRecord(test.level, "message")); err != nil {
				t.Fatalf("handle: %v", err)
			}
			if !strings.Contains(output.String(), test.label) {
				t.Fatalf("expected label %q in %q", test.label, output.String())
			}
		})
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}

func TestHandlerPropagatesWriteErrors(t *testing.T) {
	handler := NewHandler(failingWriter{}, slog.LevelInfo)
	if err := handler.Handle(context.Background(), fixedRecord(slog.LevelInfo, "lost")); err == nil {
		t.Fatal("expected writer errors to be propagated to slog")
	}
}
