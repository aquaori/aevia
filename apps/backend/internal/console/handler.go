package console

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"
)

type Handler struct {
	out   io.Writer
	level slog.Level
	attrs []slog.Attr
	mu    *sync.Mutex
}

func NewHandler(out io.Writer, level slog.Level) *Handler {
	return &Handler{out: out, level: level, mu: &sync.Mutex{}}
}

func (h *Handler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= h.level
}

func (h *Handler) Handle(_ context.Context, record slog.Record) error {
	var attrs []slog.Attr
	attrs = append(attrs, h.attrs...)
	record.Attrs(func(attr slog.Attr) bool {
		attrs = append(attrs, attr)
		return true
	})

	line := fmt.Sprintf("%s %s %s", dim(record.Time.Format("15:04:05")), levelLabel(record.Level), record.Message)
	if len(attrs) > 0 {
		line += dim("  " + formatAttrs(attrs))
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := fmt.Fprintln(h.out, line)
	return err
}

func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := *h
	next.attrs = append(append([]slog.Attr{}, h.attrs...), attrs...)
	return &next
}

func (h *Handler) WithGroup(_ string) slog.Handler {
	return h
}

func levelLabel(level slog.Level) string {
	switch {
	case level >= slog.LevelError:
		return red("ERROR")
	case level >= slog.LevelWarn:
		return yellow("WARN ")
	case level >= slog.LevelInfo:
		return cyan("INFO ")
	default:
		return dim("DEBUG")
	}
}

func formatAttrs(attrs []slog.Attr) string {
	parts := make([]string, 0, len(attrs))
	for _, attr := range attrs {
		attr.Value = attr.Value.Resolve()
		parts = append(parts, attr.Key+"="+attrValue(attr.Value))
	}
	return strings.Join(parts, " ")
}

func attrValue(value slog.Value) string {
	switch value.Kind() {
	case slog.KindString:
		return quoteIfNeeded(value.String())
	case slog.KindTime:
		return value.Time().Format(time.RFC3339)
	case slog.KindDuration:
		return value.Duration().String()
	default:
		return fmt.Sprint(value.Any())
	}
}

func quoteIfNeeded(value string) string {
	if value == "" || strings.ContainsAny(value, " \t\r\n") {
		return fmt.Sprintf("%q", value)
	}
	return value
}
