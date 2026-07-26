package console

import (
	"fmt"
	"io"

	"collaborative-whiteboard/apps/backend/internal/config"
)

func PrintStartupPanel(out io.Writer, cfg config.Config) {
	fmt.Fprintln(out)
	fmt.Fprintln(out, cyan("  Aevia Go Backend"))
	fmt.Fprintln(out, dim("  --------------------------------------------------"))
	fmt.Fprintf(out, "  %-12s %s\n", "Status", green("ready"))
	fmt.Fprintf(out, "  %-12s http://127.0.0.1:%d\n", "HTTP", cfg.Port)
	fmt.Fprintf(out, "  %-12s ws://127.0.0.1:%d/ws\n", "WebSocket", cfg.Port)
	fmt.Fprintf(out, "  %-12s %s\n", "Bind", cfg.Addr())
	fmt.Fprintf(out, "  %-12s %s\n", "Database", cfg.DBPath)
	fmt.Fprintln(out, dim("  --------------------------------------------------"))
	fmt.Fprintln(out)
}
