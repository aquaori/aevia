package room

import (
	"log/slog"
	"os"
	"time"

	"collaborative-whiteboard/apps/backend/internal/domain"
	"collaborative-whiteboard/apps/backend/internal/protocol"
)

func SendInitStream(ch chan Outbound, roomName string, client ClientInfo, result JoinResult) {
	if len(result.Deltas) > 0 {
		sendDeltaReplay(ch, result)
		return
	}
	if result.InitStreamed {
		return
	}
	profile := os.Getenv("INIT_PROFILE") == "1"
	startedAt := time.Now()
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: "init-meta", Data: map[string]any{
		"status": "connected", "userId": client.UserID, "userName": client.UserName,
		"roomId": result.Room.RoomID, "roomName": roomName, "onlineCount": result.Online,
		"memberList": result.Members, "snapshotVersion": result.Init.SnapshotVersion,
		"totalPage": result.Init.Meta["totalPage"], "pageId": result.Init.Meta["pageId"],
		"loadedPageIds": result.Init.Meta["loadedPageIds"], "chunkSummary": result.Init.Meta["chunkSummary"],
		"maxLamport": result.Init.Meta["maxLamport"],
	}}})
	renderStartedAt := time.Now()
	sendRenderStream(ch, "init", 0, result.Init)
	renderDuration := time.Since(renderStartedAt)
	commandsStartedAt := time.Now()
	sendCommandStream(ch, "init", 0, result.Init)
	commandsDuration := time.Since(commandsStartedAt)
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: "init-complete", Data: map[string]any{"snapshotVersion": result.Init.SnapshotVersion}}})
	if profile {
		slog.Info("init profile send",
			"room", result.Room.RoomID,
			"renderChunks", len(result.Init.RenderChunks),
			"commandChunks", len(result.Init.CommandChunks),
			"renderSendMs", renderDuration.Milliseconds(),
			"commandSendMs", commandsDuration.Milliseconds(),
			"totalMs", time.Since(startedAt).Milliseconds(),
		)
	}
}

func (b SnapshotBuilder) SendLiveInitStream(ch chan Outbound, state State, client ClientInfo, online int, members [][2]string) {
	profile := os.Getenv("INIT_PROFILE") == "1"
	startedAt := time.Now()
	current := normalizePageID(client.PageID, state.Room.TotalPage)
	loaded := initPageIDs(current, state.Room.TotalPage, b.cfg.InitPreloadPageCount)
	snapshotVersion := int(state.RoomSeq)
	renderPageIDs := []int{current}
	renderPointCount := state.Index.VisiblePagePointCount(renderPageIDs, state.ClearBefore)
	renderChunkCount := chunkCount(renderPointCount, b.cfg.InitFlatPointChunkSize)
	commandCount := countCommandsForPages(state.Commands, loaded, state.ClearBefore)
	commandChunkCount := chunkCount(commandCount, b.cfg.InitCommandChunkSize)
	meta := map[string]any{
		"pageId":        current,
		"totalPage":     state.Room.TotalPage,
		"loadedPageIds": loaded,
		"maxLamport":    maxCommandLamport(state.Commands),
		"chunkSummary": map[string]any{
			"renderChunks":       renderChunkCount,
			"commandChunks":      commandChunkCount,
			"totalRenderChunks":  renderChunkCount,
			"totalCommandChunks": commandChunkCount,
			"pointCount":         renderPointCount,
			"commandCount":       commandCount,
		},
	}
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: "init-meta", Data: map[string]any{
		"status": "connected", "userId": client.UserID, "userName": client.UserName,
		"roomId": state.Room.RoomID, "roomName": state.Room.Name, "onlineCount": online,
		"memberList": members, "snapshotVersion": snapshotVersion,
		"totalPage": state.Room.TotalPage, "pageId": current,
		"loadedPageIds": loaded, "chunkSummary": meta["chunkSummary"], "maxLamport": meta["maxLamport"],
	}}})
	renderStartedAt := time.Now()
	sendRenderStreamFromIndex(ch, "init", 0, snapshotVersion, meta, state.Index, renderPageIDs, state.ClearBefore, renderPointCount, renderChunkCount, b.cfg.InitFlatPointChunkSize)
	renderDuration := time.Since(renderStartedAt)
	commandsStartedAt := time.Now()
	sendCommandStreamFromState(ch, "init", 0, snapshotVersion, meta, state.Commands, loaded, state.ClearBefore, commandChunkCount, b.cfg.InitCommandChunkSize)
	commandsDuration := time.Since(commandsStartedAt)
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: "init-complete", Data: map[string]any{"snapshotVersion": snapshotVersion}}})
	if profile {
		slog.Info("init profile live send",
			"room", state.Room.RoomID,
			"renderChunks", renderChunkCount,
			"commandChunks", commandChunkCount,
			"renderSendMs", renderDuration.Milliseconds(),
			"commandSendMs", commandsDuration.Milliseconds(),
			"totalMs", time.Since(startedAt).Milliseconds(),
		)
	}
}

func sendDeltaReplay(ch chan Outbound, result JoinResult) {
	sendOutbound(ch, Outbound{JSON: Envelope{Type: "delta-replay-meta", Data: map[string]any{
		"roomId":      result.Room.RoomID,
		"fromRoomSeq": result.Deltas[0].RoomSeq,
		"toRoomSeq":   result.Deltas[len(result.Deltas)-1].RoomSeq,
		"totalEvents": len(result.Deltas),
	}}})
	for _, delta := range result.Deltas {
		if delta.Binary != nil {
			sendOutbound(ch, Outbound{Binary: delta.Binary})
			continue
		}
		sendOutbound(ch, Outbound{JSON: Envelope{Type: delta.Type, Data: delta.Data}})
	}
	sendOutbound(ch, Outbound{JSON: Envelope{Type: "delta-replay-complete", Data: map[string]any{
		"roomSeq": result.Deltas[len(result.Deltas)-1].RoomSeq,
	}}})
}

func sendPageChangeStream(ch chan Outbound, stream InitStream) {
	requestID, _ := stream.Meta["requestId"].(int)
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: "page-change-meta", Data: withStreamMeta(stream)}})
	sendRenderStream(ch, "page-change", requestID, stream)
	sendCommandStream(ch, "page-change", requestID, stream)
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: "page-change-complete", Data: map[string]any{"requestId": requestID, "snapshotVersion": stream.SnapshotVersion, "mode": stream.Meta["mode"]}}})
}

func sendRenderStream(ch chan Outbound, prefix string, requestID int, stream InitStream) {
	metaType := prefix + "-render-meta"
	doneType := prefix + "-render-done"
	chunkType := prefix + "-render-chunk-meta"
	data := map[string]any{"snapshotVersion": stream.SnapshotVersion, "pageId": stream.Meta["pageId"], "totalChunks": len(stream.RenderChunks)}
	if requestID > 0 {
		data["requestId"] = requestID
	}
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: metaType, Data: data}})
	for _, chunk := range stream.RenderChunks {
		commandMap, commands := protocol.BuildRenderDictionary(chunk.Points)
		frame, err := protocol.EncodeRenderChunk(chunk.Points, commandMap, stream.SnapshotVersion, chunk.ChunkIndex)
		if err != nil {
			// Better to make the client resync than to paint points with another
			// command's attributes.
			slog.Error("render chunk encode failed", "chunkIndex", chunk.ChunkIndex, "error", err)
			sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: "resync.required", Data: map[string]any{
				"reason": "render-chunk-encode-failed",
			}}})
			return
		}
		chunkData := map[string]any{
			"snapshotVersion": stream.SnapshotVersion, "chunkIndex": chunk.ChunkIndex,
			"isLastChunk": chunk.IsLast, "pointCount": len(chunk.Points), "commands": commands,
			"lamportStart": chunk.LamportStart, "lamportEnd": chunk.LamportEnd,
		}
		if requestID > 0 {
			chunkData["requestId"] = requestID
		}
		sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: chunkType, Data: chunkData}})
		sendStreamOutbound(ch, Outbound{Binary: frame})
	}
	done := map[string]any{"snapshotVersion": stream.SnapshotVersion, "totalChunks": len(stream.RenderChunks)}
	if requestID > 0 {
		done["requestId"] = requestID
	}
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: doneType, Data: done}})
}

func sendCommandStream(ch chan Outbound, prefix string, requestID int, stream InitStream) {
	metaType := prefix + "-commands-meta"
	doneType := prefix + "-commands-done"
	chunkType := prefix + "-commands-chunk"
	data := map[string]any{"snapshotVersion": stream.SnapshotVersion, "loadedPageIds": stream.Meta["loadedPageIds"], "totalChunks": len(stream.CommandChunks)}
	if requestID > 0 {
		data["requestId"] = requestID
		data["loadPageIds"] = stream.Meta["loadPageIds"]
		data["unloadPageIds"] = stream.Meta["unloadPageIds"]
	}
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: metaType, Data: data}})
	for _, chunk := range stream.CommandChunks {
		chunkData := map[string]any{"snapshotVersion": stream.SnapshotVersion, "chunkIndex": chunk.ChunkIndex, "isLastChunk": chunk.IsLast, "commands": chunk.Commands}
		if requestID > 0 {
			chunkData["requestId"] = requestID
		}
		sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: chunkType, Data: chunkData}})
	}
	done := map[string]any{"snapshotVersion": stream.SnapshotVersion, "totalChunks": len(stream.CommandChunks)}
	if requestID > 0 {
		done["requestId"] = requestID
	}
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: doneType, Data: done}})
}

func sendRenderStreamFromIndex(ch chan Outbound, prefix string, requestID, snapshotVersion int, meta map[string]any, index *PagePointIndex, pageIDs []int, clearBefore map[int]sceneOrderKey, totalPoints, totalChunks, chunkSize int) {
	metaType := prefix + "-render-meta"
	doneType := prefix + "-render-done"
	chunkType := prefix + "-render-chunk-meta"
	data := map[string]any{"snapshotVersion": snapshotVersion, "pageId": meta["pageId"], "totalChunks": totalChunks}
	if requestID > 0 {
		data["requestId"] = requestID
	}
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: metaType, Data: data}})
	encodeFailed := false
	index.ForEachVisiblePagePointChunk(pageIDs, clearBefore, totalPoints, chunkSize, func(chunk RenderChunk) {
		if encodeFailed {
			return
		}
		commandMap, commands := protocol.BuildRenderDictionary(chunk.Points)
		frame, err := protocol.EncodeRenderChunk(chunk.Points, commandMap, snapshotVersion, chunk.ChunkIndex)
		if err != nil {
			slog.Error("render chunk encode failed", "chunkIndex", chunk.ChunkIndex, "error", err)
			sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: "resync.required", Data: map[string]any{
				"reason": "render-chunk-encode-failed",
			}}})
			encodeFailed = true
			return
		}
		chunkData := map[string]any{
			"snapshotVersion": snapshotVersion, "chunkIndex": chunk.ChunkIndex,
			"isLastChunk": chunk.IsLast, "pointCount": len(chunk.Points), "commands": commands,
			"lamportStart": chunk.LamportStart, "lamportEnd": chunk.LamportEnd,
		}
		if requestID > 0 {
			chunkData["requestId"] = requestID
		}
		sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: chunkType, Data: chunkData}})
		sendStreamOutbound(ch, Outbound{Binary: frame})
	})
	if encodeFailed {
		return
	}
	done := map[string]any{"snapshotVersion": snapshotVersion, "totalChunks": totalChunks}
	if requestID > 0 {
		done["requestId"] = requestID
	}
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: doneType, Data: done}})
}

func sendCommandStreamFromState(ch chan Outbound, prefix string, requestID, snapshotVersion int, meta map[string]any, commands map[string]domain.Command, pageIDs []int, clearBefore map[int]sceneOrderKey, totalChunks, chunkSize int) {
	metaType := prefix + "-commands-meta"
	doneType := prefix + "-commands-done"
	chunkType := prefix + "-commands-chunk"
	data := map[string]any{"snapshotVersion": snapshotVersion, "loadedPageIds": meta["loadedPageIds"], "totalChunks": totalChunks}
	if requestID > 0 {
		data["requestId"] = requestID
		data["loadPageIds"] = meta["loadPageIds"]
		data["unloadPageIds"] = meta["unloadPageIds"]
	}
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: metaType, Data: data}})
	if chunkSize <= 0 {
		chunkSize = 128
	}
	chunk := make([]domain.Command, 0, chunkSize)
	chunkIndex := 0
	emit := func(isLast bool) {
		chunkData := map[string]any{"snapshotVersion": snapshotVersion, "chunkIndex": chunkIndex, "isLastChunk": isLast, "commands": chunk}
		if requestID > 0 {
			chunkData["requestId"] = requestID
		}
		sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: chunkType, Data: chunkData}})
		chunkIndex++
		chunk = make([]domain.Command, 0, chunkSize)
	}
	allowed := pageIDSet(pageIDs)
	ordered := make([]domain.Command, 0, len(commands))
	for _, cmd := range commands {
		pageID, ok := cmd.PageID()
		if !ok || !allowed[pageID] || !commandVisibleAfterClear(cmd, clearBefore) {
			continue
		}
		ordered = append(ordered, cmd)
	}
	domain.SortCommands(ordered)
	for _, cmd := range ordered {
		chunk = append(chunk, cmd.Snapshot())
		if len(chunk) >= chunkSize {
			emit(chunkIndex == totalChunks-1)
		}
	}
	if len(chunk) > 0 {
		emit(true)
	}
	done := map[string]any{"snapshotVersion": snapshotVersion, "totalChunks": totalChunks}
	if requestID > 0 {
		done["requestId"] = requestID
	}
	sendStreamOutbound(ch, Outbound{JSON: Envelope{Type: doneType, Data: done}})
}

func countCommandsForPages(commands map[string]domain.Command, pageIDs []int, clearBefore map[int]sceneOrderKey) int {
	allowed := pageIDSet(pageIDs)
	count := 0
	for _, cmd := range commands {
		pageID, ok := cmd.PageID()
		if ok && allowed[pageID] && commandVisibleAfterClear(cmd, clearBefore) {
			count++
		}
	}
	return count
}

func pageIDSet(pageIDs []int) map[int]bool {
	allowed := make(map[int]bool, len(pageIDs))
	for _, pageID := range pageIDs {
		allowed[pageID] = true
	}
	return allowed
}

func chunkCount(items, chunkSize int) int {
	if items <= 0 {
		return 0
	}
	if chunkSize <= 0 {
		return 1
	}
	return (items + chunkSize - 1) / chunkSize
}

func sendStreamOutbound(ch chan Outbound, msg Outbound) bool {
	msg.Frozen = true
	return sendOutbound(ch, msg)
}

func withStreamMeta(stream InitStream) map[string]any {
	out := map[string]any{"snapshotVersion": stream.SnapshotVersion}
	for k, v := range stream.Meta {
		out[k] = v
	}
	return out
}
