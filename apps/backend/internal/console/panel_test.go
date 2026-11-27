package console

import (
	"bytes"
	"strings"
	"testing"

	"collaborative-whiteboard/apps/backend/internal/config"
)

func TestPrintStartupPanel(t *testing.T) {
	var buf bytes.Buffer
	PrintStartupPanel(&buf, config.Config{
		Host:   "127.0.0.1",
		Port:   4567,
		DBPath: "/tmp/aevia-test.sqlite",
	})
	out := buf.String()
	for _, want := range []string{"Aevia Go Backend", "ready", "127.0.0.1:4567", "/tmp/aevia-test.sqlite"} {
		if !strings.Contains(out, want) {
			t.Fatalf("startup panel missing %q in %q", want, out)
		}
	}
}
