package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

type APGState struct {
	Revision      int64           `json:"revision"`
	SchemaVersion int             `json:"schemaVersion"`
	Value         json.RawMessage `json:"value"`
}

func (s *Store) ReadAPGState(ctx context.Context, roomID, pluginID string) (APGState, error) {
	state := APGState{Value: json.RawMessage("null")}
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT revision,schema_version,value FROM apg_room_state WHERE room_id=? AND plugin_id=?", roomID, pluginID).Scan(&state.Revision, &state.SchemaVersion, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	if err == nil {
		state.Value = json.RawMessage(raw)
	}
	return state, err
}

// Compare-and-swap is a single SQL statement. A stale client never overwrites another writer.
func (s *Store) WriteAPGState(ctx context.Context, roomID, pluginID string, expected int64, schemaVersion int, value json.RawMessage) (bool, error) {
	if expected < 0 || expected >= 9007199254740991 || schemaVersion < 0 || schemaVersion > MaxAPGStateSchemaVersion || len(value) > 16384 || !json.Valid(value) {
		return false, errors.New("invalid APG state")
	}
	var result sql.Result
	var err error
	if expected == 0 {
		result, err = s.db.ExecContext(ctx, "INSERT INTO apg_room_state(room_id,plugin_id,revision,schema_version,value) VALUES(?,?,1,?,?) ON CONFLICT(room_id,plugin_id) DO NOTHING", roomID, pluginID, schemaVersion, string(value))
	} else {
		result, err = s.db.ExecContext(ctx, "UPDATE apg_room_state SET revision=revision+1,schema_version=?,value=? WHERE room_id=? AND plugin_id=? AND revision=? AND schema_version<=?", schemaVersion, string(value), roomID, pluginID, expected, schemaVersion)
	}
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

var (
	ErrAPGWriteUnauthorized   = errors.New("APG state write unauthorized")
	ErrAPGStateConflict       = errors.New("APG state revision conflict")
	ErrAPGStateSchemaConflict = errors.New("APG state schema would be downgraded")
)

// MaxAPGStateSchemaVersion bounds the shared-state schema version a plugin may declare.
const MaxAPGStateSchemaVersion = 1000

// WriteAPGStateAuthorized performs the room-role check and the revision CAS in
// one SQL statement, so a role change cannot land between authorization and
// the write. Failures are classified as ErrAPGWriteUnauthorized or
// ErrAPGStateConflict after the statement; that later read only labels the
// rejected write and never authorizes one.
func (s *Store) WriteAPGStateAuthorized(ctx context.Context, roomID, pluginID, actorID string, account bool, expected int64, schemaVersion int, value json.RawMessage) (bool, error) {
	if expected < 0 || expected >= 9007199254740991 || schemaVersion < 0 || schemaVersion > MaxAPGStateSchemaVersion || len(value) > 16384 || !json.Valid(value) {
		return false, errors.New("invalid APG state")
	}
	roleQuery := "SELECT 1 FROM room_members WHERE room_id=? AND user_id=? AND role IN ('owner','editor') AND banned_at IS NULL"
	if !account {
		roleQuery = "SELECT 1 FROM guest_sessions WHERE room_id=? AND user_id=? AND role IN ('owner','editor') AND kicked=0"
	}
	var result sql.Result
	var err error
	if expected == 0 {
		result, err = s.db.ExecContext(ctx,
			"INSERT OR IGNORE INTO apg_room_state(room_id,plugin_id,revision,schema_version,value) SELECT ?,?,1,?,? WHERE EXISTS ("+roleQuery+")",
			roomID, pluginID, schemaVersion, string(value), roomID, actorID)
	} else {
		result, err = s.db.ExecContext(ctx,
			"UPDATE apg_room_state SET revision=revision+1,schema_version=?,value=? WHERE room_id=? AND plugin_id=? AND revision=? AND schema_version<=? AND EXISTS ("+roleQuery+")",
			schemaVersion, string(value), roomID, pluginID, expected, schemaVersion, roomID, actorID)
	}
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if n == 1 {
		return true, nil
	}
	authorized, err := s.apgWriterAuthorized(ctx, roomID, actorID, account)
	if err != nil {
		return false, err
	}
	if !authorized {
		return false, ErrAPGWriteUnauthorized
	}
	// A stored schema newer than the request means this package would reinterpret or overwrite
	// state written by a newer version, which is exactly what a rollback must not do.
	current, readErr := s.ReadAPGState(ctx, roomID, pluginID)
	if readErr == nil && current.SchemaVersion > schemaVersion {
		return false, ErrAPGStateSchemaConflict
	}
	return false, ErrAPGStateConflict
}

func (s *Store) apgWriterAuthorized(ctx context.Context, roomID, actorID string, account bool) (bool, error) {
	if account {
		role, banned, err := s.MemberRole(ctx, roomID, actorID)
		if err != nil {
			return false, err
		}
		return !banned && (role == "owner" || role == "editor"), nil
	}
	role, kicked, err := s.GuestRole(ctx, roomID, actorID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return !kicked && (role == "owner" || role == "editor"), nil
}

// APGStateRow is the metadata view of one stored room/plugin value. The value itself is only
// returned through ReadAPGState so a listing cannot accidentally stream every payload.
type APGStateRow struct {
	RoomID        string
	PluginID      string
	Revision      int64
	SchemaVersion int
}

// ListAPGState returns stored rows, optionally filtered by room and plugin. Empty filters match
// everything, which is what a deployment audit wants.
func (s *Store) ListAPGState(ctx context.Context, roomID, pluginID string) ([]APGStateRow, error) {
	query := "SELECT room_id,plugin_id,revision,schema_version FROM apg_room_state"
	var clauses []string
	var args []any
	if roomID != "" {
		clauses = append(clauses, "room_id=?")
		args = append(args, roomID)
	}
	if pluginID != "" {
		clauses = append(clauses, "plugin_id=?")
		args = append(args, pluginID)
	}
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	query += " ORDER BY room_id, plugin_id"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []APGStateRow
	for rows.Next() {
		var row APGStateRow
		if err := rows.Scan(&row.RoomID, &row.PluginID, &row.Revision, &row.SchemaVersion); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

// ClearAPGState deletes one room's plugin state, or every plugin's state in that room. roomID is
// mandatory: purging the whole table in one call is not something an operator command should be
// able to do by leaving an argument out.
func (s *Store) ClearAPGState(ctx context.Context, roomID, pluginID string) (int64, error) {
	if roomID == "" {
		return 0, errors.New("room id is required")
	}
	var result sql.Result
	var err error
	if pluginID == "" {
		result, err = s.db.ExecContext(ctx, "DELETE FROM apg_room_state WHERE room_id=?", roomID)
	} else {
		result, err = s.db.ExecContext(ctx, "DELETE FROM apg_room_state WHERE room_id=? AND plugin_id=?", roomID, pluginID)
	}
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
