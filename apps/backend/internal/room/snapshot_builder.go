package room

import (
	"log/slog"
	"os"
	"time"

	"collaborative-whiteboard/apps/backend/internal/config"
	"collaborative-whiteboard/apps/backend/internal/domain"
)

type SnapshotBuilder struct {
	cfg config.Config
}

func NewSnapshotBuilder(cfg config.Config) SnapshotBuilder {
	return SnapshotBuilder{cfg: cfg}
}

func (b SnapshotBuilder) Init(state State, pageID int) InitStream {
	current := normalizePageID(pageID, state.Room.TotalPage)
	loaded := initPageIDs(current, state.Room.TotalPage, b.cfg.InitPreloadPageCount)
	return b.build(state, current, []int{current}, loaded, map[string]any{
		"pageId":        current,
		"totalPage":     state.Room.TotalPage,
		"loadedPageIds": loaded,
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
	})
}

func (b SnapshotBuilder) build(state State, pageID int, renderPageIDs, commandPageIDs []int, meta map[string]any) InitStream {
	startedAt := time.Now()
	profile := os.Getenv("INIT_PROFILE") == "1"
	pointsStartedAt := time.Now()
	points := state.Index.VisiblePagePoints(renderPageIDs, state.ClearBefore)
	pointsDuration := time.Since(pointsStartedAt)
	commandsStartedAt := time.Now()
	commands := commandsForPages(state.Commands, commandPageIDs, state.ClearBefore)
	commandsDuration := time.Since(commandsStartedAt)
	renderChunksStartedAt := time.Now()
	renderChunks := chunkFlatPoints(points, b.cfg.InitFlatPointChunkSize)
	renderChunksDuration := time.Since(renderChunksStartedAt)
	commandChunksStartedAt := time.Now()
	commandChunks := chunkCommands(commands, b.cfg.InitCommandChunkSize)
	commandChunksDuration := time.Since(commandChunksStartedAt)
	meta["maxLamport"] = maxCommandLamport(state.Commands)
	meta["chunkSummary"] = map[string]any{
		"renderChunks":  len(renderChunks),
		"commandChunks": len(commandChunks),
		"pointCount":    len(points),
		"commandCount":  len(commands),
	}
	if profile {
		slog.Info("init profile build",
			"page", pageID,
			"points", len(points),
			"commands", len(commands),
			"renderChunks", len(renderChunks),
			"commandChunks", len(commandChunks),
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
	allowed := make(map[int]bool, len(pageIDs))
	for _, pageID := range pageIDs {
		allowed[pageID] = true
	}
	out := make([]domain.Command, 0)
	for _, cmd := range commands {
		pageID, ok := cmd.PageID()
		if !ok || !allowed[pageID] {
			continue
		}
		if !commandVisibleAfterClear(cmd, clearBefore) {
			continue
		}
		out = append(out, cmd.Snapshot())
	}
	domain.SortCommands(out)
	return out
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
	chunks := make([]CommandChunk, 0, (len(commands)+chunkSize-1)/chunkSize)
	for start := 0; start < len(commands); start += chunkSize {
		end := start + chunkSize
		if end > len(commands) {
			end = len(commands)
		}
		chunkCommands := commands[start:end]
		chunks = append(chunks, CommandChunk{
			ChunkIndex: len(chunks),
			IsLast:     end == len(commands),
			Commands:   chunkCommands,
		})
	}
	return chunks
}

func valueOr(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}
