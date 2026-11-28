package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/storage"
)

// openStateStore opens the deployment database for read/inspect operations without starting a
// server. It refuses a path that does not exist so a typo cannot create an empty database and
// report "no state" as if the room were clean.
func openStateStore(path string) (*storage.Store, error) {
	if path == "" {
		return nil, errors.New("usage: apg state <list|clear> <database-path> ...")
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return nil, fmt.Errorf("database %q does not exist", path)
	}
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	cfg.DBPath = path
	cfg.DBBusyTimeout = 5 * time.Second
	return storage.Open(cfg)
}

// runState implements `apg state ...`. Shared state is room-scoped plugin data that survives
// plugin uninstall by design, so a deployment needs a supported way to inspect and purge it.
func runState(args []string, out io.Writer) error {
	if len(args) < 2 {
		return errors.New("usage: apg state list <database-path> [room-id] [plugin-id] | apg state clear <database-path> <room-id> [plugin-id] --confirm")
	}
	action := args[0]
	store, err := openStateStore(args[1])
	if err != nil {
		return err
	}
	defer store.Close()

	ctx := context.Background()
	switch action {
	case "list":
		rest := args[2:]
		if len(rest) > 2 {
			return errors.New("usage: apg state list <database-path> [room-id] [plugin-id]")
		}
		var room, plugin string
		if len(rest) > 0 {
			room = rest[0]
		}
		if len(rest) > 1 {
			plugin = rest[1]
		}
		rows, err := store.ListAPGState(ctx, room, plugin)
		if err != nil {
			return err
		}
		for _, row := range rows {
			fmt.Fprintf(out, "%s\t%s\trevision=%d\tschema=%d\n", row.RoomID, row.PluginID, row.Revision, row.SchemaVersion)
		}
		return nil
	case "clear":
		rest := args[2:]
		confirm := false
		if len(rest) > 0 && rest[len(rest)-1] == "--confirm" {
			confirm = true
			rest = rest[:len(rest)-1]
		}
		if len(rest) < 1 || len(rest) > 2 {
			return errors.New("usage: apg state clear <database-path> <room-id> [plugin-id] --confirm")
		}
		if !confirm {
			return errors.New("refusing to delete shared state without --confirm")
		}
		var plugin string
		if len(rest) == 2 {
			plugin = rest[1]
		}
		deleted, err := store.ClearAPGState(ctx, rest[0], plugin)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "deleted %d shared-state row(s)\n", deleted)
		return nil
	default:
		return fmt.Errorf("unknown state action %q", action)
	}
}
