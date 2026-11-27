package room

import (
	"encoding/json"
	"log/slog"
	"os"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/domain"
)

type SnapshotBuilder struct {
	cfg   config.Config
	cache *initSnapshotCache
}

func NewSnapshotBuilder(cfg config.Config) SnapshotBuilder {
	return SnapshotBuilder{cfg: cfg, cache: newInitSnapshotCache()}
}

// newInitSnapshotState contains only the detached data consumed by Init. The
// actor already captured clear watermarks at the same room sequence, so this
// read-only state must not rebuild them from the filtered command subset.
func newInitSnapshotState(room domain.Room, commands []domain.Command, clearBefore map[int]sceneOrderKey) State {
	commandMap := make(map[string]domain.Command, len(commands))
	for _, cmd := range commands {
		commandMap[cmd.ID()] = cmd
	}
	return State{
		Room:        room,
		RoomSeq:     room.DurableSeq,
		Commands:    commandMap,
		Index:       NewPagePointIndex(commands),
		ClearBefore: clearBefore,
	}
}

func (b SnapshotBuilder) Init(state State, pageID int) InitStream {
	return b.init(state, pageID, true)
}

// initDetached is used only for a state reconstructed from an isolated read
// snapshot. Its commands are no longer shared with the live room actor.
func (b SnapshotBuilder) initDetached(state State, pageID int) InitStream {
	return b.init(state, pageID, false)
}

func (b SnapshotBuilder) init(state State, pageID int, copyCommands bool) InitStream {
	current := normalizePageID(pageID, state.Room.TotalPage)
	key := initCacheKey{
		roomID:       state.Room.RoomID,
		pageID:       current,
		totalPage:    state.Room.TotalPage,
		roomSeq:      state.RoomSeq,
		preloadPages: b.cfg.InitPreloadPageCount,
		clearSig:     clearBeforeSignature(state.ClearBefore),
	}
	if cached, ok := b.cache.get(key); ok {
		return cached
	}
	loaded := initPageIDs(current, state.Room.TotalPage, b.cfg.InitPreloadPageCount)
	stream := b.build(state, current, []int{current}, loaded, map[string]any{
		"pageId":        current,
		"totalPage":     state.Room.TotalPage,
		"loadedPageIds": loaded,
	}, copyCommands)
	return b.cache.put(key, stream)
}

func (b SnapshotBuilder) TryCachedInit(roomID string, pageID, totalPage int, roomSeq uint64, clearBefore map[int]sceneOrderKey) (InitStream, bool) {
	current := normalizePageID(pageID, totalPage)
	return b.cache.get(initCacheKey{
		roomID:       roomID,
		pageID:       current,
		totalPage:    totalPage,
		roomSeq:      roomSeq,
		preloadPages: b.cfg.InitPreloadPageCount,
		clearSig:     clearBeforeSignature(clearBefore),
	})
}

func (b SnapshotBuilder) PageChange(state State, req PageChangeRequest) InitStream {
	current := valueOr(req.PageID, 0)
	if req.NextPageID != nil {
		current = *req.NextPageID
	}
	current = normalizePageID(current, state.Room.TotalPage)

	previous := sanitizePageIDs(req.ClientLoadedPageIDs, state.Room.TotalPage)
	next := adjacentPageIDs(current, state.Room.TotalPage, b.cfg.PageCacheRadius)
	load, unload := diffPageIDs(previous, next)
	return b.build(state, current, []int{current}, load, map[string]any{
		"requestId":     req.RequestID,
		"pageId":        current,
		"totalPage":     state.Room.TotalPage,
		"loadedPageIds": next,
		"loadPageIds":   load,
		"unloadPageIds": unload,
		"mode":          "window",
	}, true)
}

func (b SnapshotBuilder) build(state State, pageID int, renderPageIDs, commandPageIDs []int, meta map[string]any, copyCommands bool) InitStream {
	startedAt := time.Now()
	profile := os.Getenv("INIT_PROFILE") == "1"
	pointsStartedAt := time.Now()
	points := state.Index.VisiblePagePoints(renderPageIDs, state.ClearBefore)
	pointsDuration := time.Since(pointsStartedAt)
	commandsStartedAt := time.Now()
	commands := commandsForPagesWithCopy(state.Commands, commandPageIDs, state.ClearBefore, copyCommands)
	commandsDuration := time.Since(commandsStartedAt)
	renderChunksStartedAt := time.Now()
	renderChunks := chunkFlatPoints(points, b.cfg.InitFlatPointChunkSize)
	renderChunksDuration := time.Since(renderChunksStartedAt)
	commandChunksStartedAt := time.Now()
	var commandChunks []CommandChunk
	var prepareCommands func() []CommandChunk
	if copyCommands {
		commandChunks = chunkCommands(commands, b.cfg.InitCommandChunkSize)
	} else {
		prepareCommands = func() []CommandChunk { return chunkCommands(commands, b.cfg.InitCommandChunkSize) }
	}
	commandChunksDuration := time.Since(commandChunksStartedAt)
	meta["maxLamport"] = maxCommandLamport(state.Commands)
	summary := map[string]any{
		"renderChunks":      len(renderChunks),
		"totalRenderChunks": len(renderChunks),
		"pointCount":        len(points),
		"commandCount":      len(commands),
	}
	if prepareCommands == nil {
		summary["commandChunks"] = len(commandChunks)
		summary["totalCommandChunks"] = len(commandChunks)
	}
	meta["chunkSummary"] = summary
	if profile {
		slog.Info("init profile build",
			"page", pageID,
			"points", len(points),
			"commands", len(commands),
			"renderChunks", len(renderChunks),
			"commandChunks", len(commandChunks),
			"commandChunksDeferred", prepareCommands != nil,
			"pagePointsMs", pointsDuration.Milliseconds(),
			"commandsMs", commandsDuration.Milliseconds(),
			"renderChunksMs", renderChunksDuration.Milliseconds(),
			"commandChunksMs", commandChunksDuration.Milliseconds(),
			"totalMs", time.Since(startedAt).Milliseconds(),
		)
	}
	return InitStream{
		SnapshotVersion: int(state.RoomSeq),
		Meta:            meta,
		RenderChunks:    renderChunks,
		CommandChunks:   commandChunks,
		prepareCommands: prepareCommands,
	}
}

func maxCommandLamport(commands map[string]domain.Command) float64 {
	maxLamport := 0.0
	for _, cmd := range commands {
		lamport := domain.FloatDefault(cmd.Get("lamport"), 0)
		if operation := sceneOperation(cmd); operation != nil {
			lamport = domain.FloatDefault(operation["lamport"], lamport)
		}
		if lamport > maxLamport {
			maxLamport = lamport
		}
	}
	return maxLamport
}

func commandsForPages(
	commands map[string]domain.Command,
	pageIDs []int,
	clearBefore map[int]sceneOrderKey,
) []domain.Command {
	return commandsForPagesWithCopy(commands, pageIDs, clearBefore, true)
}

func commandsForPagesWithCopy(
	commands map[string]domain.Command,
	pageIDs []int,
	clearBefore map[int]sceneOrderKey,
	copyCommands bool,
) []domain.Command {
	allowed := make(map[int]bool, len(pageIDs))
	for _, pageID := range pageIDs {
		allowed[pageID] = true
	}
	out := make([]domain.Command, 0)
	hiddenPaths := hiddenClearedPaths(commands, clearBefore)
	for _, cmd := range commands {
		pageID, ok := cmd.PageID()
		if !ok || !allowed[pageID] {
			continue
		}
		if !commandVisibleAfterClear(cmd, clearBefore) || isHiddenPathAppend(cmd, hiddenPaths) {
			continue
		}
		if copyCommands {
			cmd = cmd.Snapshot()
		}
		out = append(out, cmd)
	}
	domain.SortCommands(out)
	return out
}

// Appends to a path created before a clear remain hidden with that path. Sending
// them without their filtered create leaves clients waiting for a missing parent.
func hiddenClearedPaths(commands map[string]domain.Command, clearBefore map[int]sceneOrderKey) map[string]bool {
	if len(clearBefore) == 0 {
		return nil
	}
	hidden := make(map[string]bool)
	for _, cmd := range commands {
		operation := sceneOperation(cmd)
		if domain.String(operation["kind"]) != "element.create" {
			continue
		}
		page, ok := cmd.PageID()
		watermark, cleared := clearBefore[page]
		if ok && cleared && compareSceneOrder(commandSceneOrder(cmd), watermark) <= 0 {
			hidden[domain.String(operation["elementId"])] = true
		}
	}
	return hidden
}

func isHiddenPathAppend(cmd domain.Command, hiddenPaths map[string]bool) bool {
	if len(hiddenPaths) == 0 {
		return false
	}
	operation := sceneOperation(cmd)
	return domain.String(operation["kind"]) == "element.append" && hiddenPaths[domain.String(operation["elementId"])]
}

func commandVisibleAfterClear(cmd domain.Command, clearBefore map[int]sceneOrderKey) bool {
	pageID, ok := cmd.PageID()
	if !ok {
		return false
	}
	watermark, hasWatermark := clearBefore[pageID]
	if !hasWatermark {
		return true
	}
	comparison := compareSceneOrder(commandSceneOrder(cmd), watermark)
	return comparison > 0 || (comparison == 0 && sceneOperationKind(cmd) == "page.clear")
}

func commandSceneOrder(cmd domain.Command) sceneOrderKey {
	operation := sceneOperation(cmd)
	opID := domain.String(operation["opId"])
	if opID == "" {
		opID = cmd.ID()
	}
	return sceneOrderKey{
		Lamport: domain.FloatDefault(operation["lamport"], domain.FloatDefault(cmd.Get("lamport"), 0)),
		OpID:    opID,
	}
}

func chunkFlatPoints(points []domain.FlatPoint, chunkSize int) []RenderChunk {
	if len(points) == 0 {
		return nil
	}
	chunks := make([]RenderChunk, 0, (len(points)+chunkSize-1)/chunkSize)
	for start := 0; start < len(points); start += chunkSize {
		end := start + chunkSize
		if end > len(points) {
			end = len(points)
		}
		chunkPoints := points[start:end]
		chunks = append(chunks, RenderChunk{
			ChunkIndex:   len(chunks),
			IsLast:       end == len(points),
			Points:       chunkPoints,
			LamportStart: chunkPoints[0].Lamport,
			LamportEnd:   chunkPoints[len(chunkPoints)-1].Lamport,
		})
	}
	return chunks
}

func chunkCommands(commands []domain.Command, chunkSize int) []CommandChunk {
	if len(commands) == 0 {
		return nil
	}
	if chunkSize <= 0 {
		chunkSize = 32
	}
	const maxChunkBytes = 64 * 1024
	chunks := make([]CommandChunk, 0, (len(commands)+chunkSize-1)/chunkSize)
	encodedCommands := make([]json.RawMessage, len(commands))
	start, bytes := 0, 0
	for index, command := range commands {
		encoded, err := json.Marshal(command)
		if err == nil {
			encodedCommands[index] = encoded
		}
		size := len(encoded) + 1
		if index > start && (index-start >= chunkSize || bytes+size > maxChunkBytes) {
			chunks = append(chunks, CommandChunk{ChunkIndex: len(chunks), Commands: commands[start:index], encoded: append([]json.RawMessage(nil), encodedCommands[start:index]...)})
			start, bytes = index, 0
		}
		bytes += size
	}
	chunks = append(chunks, CommandChunk{ChunkIndex: len(chunks), IsLast: true, Commands: commands[start:], encoded: append([]json.RawMessage(nil), encodedCommands[start:]...)})
	return chunks
}

func valueOr(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}
