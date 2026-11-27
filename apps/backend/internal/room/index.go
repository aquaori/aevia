package room

import (
	"sort"

	"collaborative-whiteboard/apps/backend/internal/domain"
)

const (
	pointBlockSize              = 2000
	maxPendingOrphanFragments   = 2048
	maxPendingOrphansPerElement = 512
)

type PagePointIndex struct {
	version              int
	pages                map[int]*pagePointBlocks
	locators             map[string]commandPointLocator
	scenePathStyles      map[string]scenePathStyle
	pendingFragments     map[string][]pendingSceneFragment
	pendingTotal         int
	quarantinedFragments uint64
}

type pendingSceneFragment struct {
	cmdID    string
	fragment domain.ScenePathFragment
}

type commandPointLocator struct {
	pageID      int
	points      int
	deleted     bool
	lastTool    string
	pointCmdID  string
	immutableV2 bool
	createOrder sceneOrderKey
}

type scenePathStyle struct {
	pageID        int
	tool          string
	color         string
	size          float64
	strokePattern string
	createOrder   sceneOrderKey
}

type pagePointBlocks struct {
	blocks [][]domain.FlatPoint
}

func NewPagePointIndex(commands []domain.Command) *PagePointIndex {
	idx := &PagePointIndex{
		pages:            make(map[int]*pagePointBlocks),
		locators:         make(map[string]commandPointLocator),
		scenePathStyles:  make(map[string]scenePathStyle),
		pendingFragments: make(map[string][]pendingSceneFragment),
	}
	// Persisted commands are held in a map by the room state and therefore have
	// no reliable iteration order. Collect create metadata first so an append can
	// be projected even when it happens to be visited before its create command.
	for _, cmd := range commands {
		fragment, ok := domain.ScenePathFragmentFromCommand(cmd)
		if ok && fragment.IsCreate {
			idx.scenePathStyles[fragment.ElementID] = scenePathStyle{
				pageID: fragment.PageID, tool: fragment.Tool, color: fragment.Color, size: fragment.Size, strokePattern: fragment.StrokePattern,
				createOrder: sceneOrderKey{Lamport: fragment.Lamport, OpID: fragment.OperationID},
			}
		}
	}
	for _, cmd := range commands {
		idx.Upsert(cmd)
	}
	return idx
}

func (i *PagePointIndex) Version() int {
	return i.version
}

func (i *PagePointIndex) Upsert(cmd domain.Command) {
	cmdID := cmd.ID()
	if cmdID == "" {
		return
	}
	if fragment, ok := domain.ScenePathFragmentFromCommand(cmd); ok {
		i.upsertScenePathFragment(cmdID, fragment)
		return
	}
	points := cmd.Points()
	pageID, ok := cmd.PageID()
	if !ok || pageID < 0 {
		i.Remove(cmdID)
		return
	}
	deleted := cmd.IsDeleted()
	tool := domain.StringDefault(cmd.Get("tool"), "pen")
	locator, exists := i.locators[cmdID]
	if exists && canAppendIndexPoints(locator, pageID, len(points), deleted, tool) {
		i.appendCommandPoints(cmd, locator.points)
		return
	}

	// A new legacy command cannot have existing points unless it collides with
	// a V2 scene path, whose points are indexed by element id instead of op id.
	// Avoid a full-page fallback scan for the common new-command case.
	_, scenePathCollision := i.scenePathStyles[cmdID]
	if exists || scenePathCollision {
		i.Remove(cmdID)
	}
	flatPoints := domain.FlattenCommand(cmd)
	if len(flatPoints) == 0 {
		i.locators[cmdID] = commandPointLocator{pageID: pageID, points: len(points), deleted: deleted, lastTool: tool, pointCmdID: cmdID}
		return
	}
	pointsByPage := make(map[int][]domain.FlatPoint)
	for _, point := range flatPoints {
		pointsByPage[point.PageID] = append(pointsByPage[point.PageID], point)
	}
	for pageID, pagePoints := range pointsByPage {
		page := i.ensurePage(pageID)
		page.insertMany(pagePoints)
	}
	i.locators[cmdID] = commandPointLocator{
		pageID: pageID, points: len(points), deleted: deleted, lastTool: tool, pointCmdID: cmdID,
		createOrder: sceneOrderKey{Lamport: flatPoints[0].Lamport, OpID: cmdID},
	}
	i.version++
}

func (i *PagePointIndex) upsertScenePathFragment(cmdID string, fragment domain.ScenePathFragment) {
	if locator, exists := i.locators[cmdID]; exists && locator.immutableV2 {
		return
	}
	var pending []pendingSceneFragment
	if fragment.IsCreate {
		i.scenePathStyles[fragment.ElementID] = scenePathStyle{
			pageID: fragment.PageID, tool: fragment.Tool, color: fragment.Color, size: fragment.Size, strokePattern: fragment.StrokePattern,
			createOrder: sceneOrderKey{Lamport: fragment.Lamport, OpID: fragment.OperationID},
		}
		if queued := i.pendingFragments[fragment.ElementID]; len(queued) > 0 {
			pending = queued
			delete(i.pendingFragments, fragment.ElementID)
			i.pendingTotal -= len(pending)
			if i.pendingTotal < 0 {
				i.pendingTotal = 0
			}
		}
	}
	style, ok := i.scenePathStyles[fragment.ElementID]
	if !ok {
		i.enqueuePendingFragment(cmdID, fragment)
		return
	}
	if style.pageID != fragment.PageID {
		return
	}
	flatPoints := make([]domain.FlatPoint, 0, len(fragment.Points))
	for index, point := range fragment.Points {
		flatPoints = append(flatPoints, domain.FlatPoint{
			X: point.X, Y: point.Y, P: point.P, Lamport: point.Lamport,
			CmdID: fragment.ElementID, OrderOpID: fragment.OperationID,
			PageID: fragment.PageID, UserID: fragment.UserID,
			Tool: style.tool, Color: style.color, Size: style.size, StrokePattern: style.strokePattern,
			PointIndex: fragment.SourceStart + index,
		})
	}
	if len(flatPoints) > 0 {
		i.ensurePage(fragment.PageID).insertMany(flatPoints)
		i.version++
	}
	i.locators[cmdID] = commandPointLocator{
		pageID: fragment.PageID, points: len(fragment.Points), lastTool: style.tool,
		pointCmdID: fragment.ElementID, immutableV2: true, createOrder: style.createOrder,
	}
	if len(pending) > 0 {
		sort.Slice(pending, func(a, b int) bool {
			if pending[a].fragment.Lamport != pending[b].fragment.Lamport {
				return pending[a].fragment.Lamport < pending[b].fragment.Lamport
			}
			if pending[a].fragment.OperationID != pending[b].fragment.OperationID {
				return pending[a].fragment.OperationID < pending[b].fragment.OperationID
			}
			return pending[a].fragment.SourceStart < pending[b].fragment.SourceStart
		})
		for _, item := range pending {
			i.upsertScenePathFragment(item.cmdID, item.fragment)
		}
	}
}

func (i *PagePointIndex) enqueuePendingFragment(cmdID string, fragment domain.ScenePathFragment) {
	if i.pendingFragments == nil {
		i.pendingFragments = make(map[string][]pendingSceneFragment)
	}
	existing := i.pendingFragments[fragment.ElementID]
	for idx, item := range existing {
		if item.cmdID == cmdID {
			existing[idx] = pendingSceneFragment{cmdID: cmdID, fragment: fragment}
			return
		}
	}
	if len(existing) >= maxPendingOrphansPerElement || i.pendingTotal >= maxPendingOrphanFragments {
		i.quarantinedFragments++
		return
	}
	i.pendingFragments[fragment.ElementID] = append(existing, pendingSceneFragment{cmdID: cmdID, fragment: fragment})
	i.pendingTotal++
}

func (i *PagePointIndex) PendingFragmentCount() int {
	return i.pendingTotal
}

func (i *PagePointIndex) DroppedOrphanCount() uint64 {
	return i.quarantinedFragments
}

func (i *PagePointIndex) QuarantinedElementIDs() []string {
	if len(i.pendingFragments) == 0 {
		return nil
	}
	ids := make([]string, 0, len(i.pendingFragments))
	for elementID, entries := range i.pendingFragments {
		if len(entries) > 0 {
			ids = append(ids, elementID)
		}
	}
	sort.Strings(ids)
	return ids
}

func canAppendIndexPoints(locator commandPointLocator, pageID, pointCount int, deleted bool, tool string) bool {
	return locator.pageID == pageID &&
		!locator.deleted &&
		!deleted &&
		locator.lastTool == tool &&
		pointCount > locator.points
}

func (i *PagePointIndex) appendCommandPoints(cmd domain.Command, startIndex int) {
	cmdID := cmd.ID()
	createOrder := i.locators[cmdID].createOrder
	points := cmd.Points()
	if startIndex >= len(points) {
		return
	}
	flatPoints := domain.FlattenCommandRange(cmd, startIndex)
	if len(flatPoints) == 0 {
		i.locators[cmdID] = commandPointLocator{
			pageID:      domain.IntDefault(cmd.Get("pageId"), 0),
			points:      len(points),
			deleted:     cmd.IsDeleted(),
			lastTool:    domain.StringDefault(cmd.Get("tool"), "pen"),
			createOrder: createOrder,
		}
		return
	}
	pageID := flatPoints[0].PageID
	i.ensurePage(pageID).insertMany(flatPoints)
	i.locators[cmdID] = commandPointLocator{
		pageID:      pageID,
		points:      len(points),
		deleted:     cmd.IsDeleted(),
		lastTool:    domain.StringDefault(cmd.Get("tool"), "pen"),
		pointCmdID:  cmdID,
		createOrder: createOrder,
	}
	i.version++
}

func (i *PagePointIndex) Remove(cmdID string) {
	changed := false
	if locator, ok := i.locators[cmdID]; ok {
		if page := i.pages[locator.pageID]; page != nil {
			pointCmdID := locator.pointCmdID
			if pointCmdID == "" {
				pointCmdID = cmdID
			}
			if page.removeCommand(pointCmdID) {
				changed = true
			}
			if page.empty() {
				delete(i.pages, locator.pageID)
			}
		}
		delete(i.locators, cmdID)
		if changed {
			i.version++
		}
		return
	}
	for pageID, page := range i.pages {
		if page.removeCommand(cmdID) {
			changed = true
		}
		if page.empty() {
			delete(i.pages, pageID)
		}
	}
	for elementID, pending := range i.pendingFragments {
		kept := pending[:0]
		removed := 0
		for _, item := range pending {
			if item.cmdID == cmdID {
				removed++
				continue
			}
			kept = append(kept, item)
		}
		if removed > 0 {
			i.pendingTotal -= removed
			if i.pendingTotal < 0 {
				i.pendingTotal = 0
			}
			if len(kept) == 0 {
				delete(i.pendingFragments, elementID)
			} else {
				i.pendingFragments[elementID] = kept
			}
		}
	}
	if changed {
		i.version++
	}
}

func (i *PagePointIndex) ClearPage(pageID int) {
	if _, ok := i.pages[pageID]; ok {
		delete(i.pages, pageID)
		for cmdID, locator := range i.locators {
			if locator.pageID == pageID {
				delete(i.locators, cmdID)
			}
		}
		for elementID, style := range i.scenePathStyles {
			if style.pageID == pageID {
				delete(i.scenePathStyles, elementID)
			}
		}
		i.version++
	}
	for elementID, pending := range i.pendingFragments {
		kept := pending[:0]
		removed := 0
		for _, item := range pending {
			if item.fragment.PageID == pageID {
				removed++
				continue
			}
			kept = append(kept, item)
		}
		if removed > 0 {
			i.pendingTotal -= removed
			if i.pendingTotal < 0 {
				i.pendingTotal = 0
			}
			if len(kept) == 0 {
				delete(i.pendingFragments, elementID)
			} else {
				i.pendingFragments[elementID] = kept
			}
		}
	}
}

func (i *PagePointIndex) ClearAll() {
	if len(i.pages) > 0 || len(i.pendingFragments) > 0 {
		i.pages = make(map[int]*pagePointBlocks)
		i.locators = make(map[string]commandPointLocator)
		i.scenePathStyles = make(map[string]scenePathStyle)
		i.pendingFragments = make(map[string][]pendingSceneFragment)
		i.pendingTotal = 0
		i.version++
	}
}

func (i *PagePointIndex) PagePoints(pageIDs []int) []domain.FlatPoint {
	if len(pageIDs) == 1 {
		if page := i.pages[pageIDs[0]]; page != nil {
			return page.flatten()
		}
		return nil
	}
	total := 0
	for _, pageID := range pageIDs {
		if page := i.pages[pageID]; page != nil {
			total += page.len()
		}
	}
	out := make([]domain.FlatPoint, 0, total)
	for _, pageID := range pageIDs {
		if page := i.pages[pageID]; page != nil {
			out = page.appendTo(out)
		}
	}
	if len(pageIDs) > 1 {
		domain.SortFlatPoints(out)
	}
	return out
}

func (i *PagePointIndex) VisiblePagePoints(pageIDs []int, clearBefore map[int]sceneOrderKey) []domain.FlatPoint {
	points := i.PagePoints(pageIDs)
	if len(points) == 0 || len(clearBefore) == 0 {
		return points
	}
	out := points[:0]
	for _, point := range points {
		if !i.pointVisibleAfterClear(point, clearBefore) {
			continue
		}
		out = append(out, point)
	}
	return out
}

func (i *PagePointIndex) pointVisibleAfterClear(point domain.FlatPoint, clearBefore map[int]sceneOrderKey) bool {
	watermark, hasWatermark := clearBefore[point.PageID]
	if !hasWatermark {
		return true
	}
	if style, ok := i.scenePathStyles[point.CmdID]; ok {
		return compareSceneOrder(style.createOrder, watermark) > 0
	}
	if locator, ok := i.locators[point.CmdID]; ok && locator.createOrder.OpID != "" {
		return compareSceneOrder(locator.createOrder, watermark) > 0
	}
	return compareSceneOrder(sceneOrderKey{
		Lamport: point.Lamport, OpID: point.CmdID, SourceIndex: point.PointIndex,
	}, watermark) > 0
}

func (i *PagePointIndex) VisiblePagePointCount(pageIDs []int, clearBefore map[int]sceneOrderKey) int {
	count := 0
	for _, pageID := range pageIDs {
		page := i.pages[pageID]
		if page == nil {
			continue
		}
		for _, block := range page.blocks {
			for _, point := range block {
				if i.pointVisibleAfterClear(point, clearBefore) {
					count++
				}
			}
		}
	}
	return count
}

func (i *PagePointIndex) PagePointCount(pageIDs []int) int {
	total := 0
	for _, pageID := range pageIDs {
		if page := i.pages[pageID]; page != nil {
			total += page.len()
		}
	}
	return total
}

func (i *PagePointIndex) ForEachPagePointChunk(pageIDs []int, chunkSize int, visit func(RenderChunk)) {
	if chunkSize <= 0 {
		chunkSize = pointBlockSize
	}
	if len(pageIDs) != 1 {
		points := i.PagePoints(pageIDs)
		for _, chunk := range chunkFlatPoints(points, chunkSize) {
			visit(chunk)
		}
		return
	}
	page := i.pages[pageIDs[0]]
	if page == nil {
		return
	}
	totalChunks := (page.len() + chunkSize - 1) / chunkSize
	chunkIndex := 0
	buffer := make([]domain.FlatPoint, 0, chunkSize)
	emit := func() {
		if len(buffer) == 0 {
			return
		}
		visit(RenderChunk{
			ChunkIndex:   chunkIndex,
			IsLast:       chunkIndex == totalChunks-1,
			Points:       buffer,
			LamportStart: buffer[0].Lamport,
			LamportEnd:   buffer[len(buffer)-1].Lamport,
		})
		chunkIndex++
		buffer = make([]domain.FlatPoint, 0, chunkSize)
	}
	for _, block := range page.blocks {
		for _, point := range block {
			buffer = append(buffer, point)
			if len(buffer) >= chunkSize {
				emit()
			}
		}
	}
	emit()
}

func (i *PagePointIndex) ForEachVisiblePagePointChunk(
	pageIDs []int,
	clearBefore map[int]sceneOrderKey,
	totalPoints int,
	chunkSize int,
	visit func(RenderChunk),
) {
	if totalPoints <= 0 {
		return
	}
	if chunkSize <= 0 {
		chunkSize = pointBlockSize
	}
	if len(pageIDs) != 1 {
		for _, chunk := range chunkFlatPoints(i.VisiblePagePoints(pageIDs, clearBefore), chunkSize) {
			visit(chunk)
		}
		return
	}
	page := i.pages[pageIDs[0]]
	if page == nil {
		return
	}
	totalChunks := (totalPoints + chunkSize - 1) / chunkSize
	chunkIndex := 0
	buffer := make([]domain.FlatPoint, 0, chunkSize)
	emit := func() {
		if len(buffer) == 0 {
			return
		}
		visit(RenderChunk{
			ChunkIndex:   chunkIndex,
			IsLast:       chunkIndex == totalChunks-1,
			Points:       buffer,
			LamportStart: buffer[0].Lamport,
			LamportEnd:   buffer[len(buffer)-1].Lamport,
		})
		chunkIndex++
		buffer = make([]domain.FlatPoint, 0, chunkSize)
	}
	for _, block := range page.blocks {
		for _, point := range block {
			if !i.pointVisibleAfterClear(point, clearBefore) {
				continue
			}
			buffer = append(buffer, point)
			if len(buffer) >= chunkSize {
				emit()
			}
		}
	}
	emit()
}

func (i *PagePointIndex) ensurePage(pageID int) *pagePointBlocks {
	page := i.pages[pageID]
	if page == nil {
		page = &pagePointBlocks{}
		i.pages[pageID] = page
	}
	return page
}

func (p *pagePointBlocks) insertMany(points []domain.FlatPoint) {
	if len(points) == 0 {
		return
	}
	domain.SortFlatPoints(points)
	// Bulk append when the whole run sorts after everything already stored, which
	// covers page hydration and live stroke growth. Falling through to per-point
	// insertion there cost a memmove per point.
	if p.appendSortedRun(points) {
		return
	}
	for _, point := range points {
		p.insert(point)
	}
}

// appendSortedRun appends an already-sorted run that starts after the current
// tail, reporting whether it handled the run.
func (p *pagePointBlocks) appendSortedRun(points []domain.FlatPoint) bool {
	lastBlock := len(p.blocks) - 1
	if lastBlock >= 0 {
		block := p.blocks[lastBlock]
		if len(block) > 0 && domain.CompareFlatPoint(points[0], block[len(block)-1]) <= 0 {
			return false
		}
	}
	for _, point := range points {
		p.appendTail(point)
	}
	return true
}

// appendTail appends to the final block, opening a new one at the block size
// boundary so blocks stay bounded without repeated splitting.
func (p *pagePointBlocks) appendTail(point domain.FlatPoint) {
	if len(p.blocks) == 0 || len(p.blocks[len(p.blocks)-1]) >= pointBlockSize {
		block := make([]domain.FlatPoint, 0, pointBlockSize)
		p.blocks = append(p.blocks, append(block, point))
		return
	}
	last := len(p.blocks) - 1
	p.blocks[last] = append(p.blocks[last], point)
}

func (p *pagePointBlocks) insert(point domain.FlatPoint) {
	if len(p.blocks) == 0 {
		p.blocks = append(p.blocks, []domain.FlatPoint{point})
		return
	}
	blockIndex := p.findBlock(point)
	block := p.blocks[blockIndex]
	insertAt := findPointInsertAt(block, point)
	block = append(block, domain.FlatPoint{})
	copy(block[insertAt+1:], block[insertAt:])
	block[insertAt] = point
	p.blocks[blockIndex] = block
	if len(block) > pointBlockSize*2 {
		p.split(blockIndex)
	}
}

// findBlock returns the block that should receive point.
//
// Blocks partition the page in ascending order, so the target is the first block
// whose last element is not less than the point — a binary search. This was a
// linear scan, which meant the common case (appending at the tail, where no block
// qualifies) walked every block for every point: O(points x blocks) to load a
// page, roughly 5M comparisons for 100k points.
func (p *pagePointBlocks) findBlock(point domain.FlatPoint) int {
	// Tail fast path: live drawing appends in order.
	if last := len(p.blocks) - 1; last >= 0 {
		block := p.blocks[last]
		if len(block) > 0 && domain.CompareFlatPoint(point, block[len(block)-1]) > 0 {
			return last
		}
	}
	index := sort.Search(len(p.blocks), func(i int) bool {
		block := p.blocks[i]
		if len(block) == 0 {
			return false
		}
		return domain.CompareFlatPoint(point, block[len(block)-1]) <= 0
	})
	if index >= len(p.blocks) {
		return len(p.blocks) - 1
	}
	return index
}

func findPointInsertAt(block []domain.FlatPoint, point domain.FlatPoint) int {
	left, right := 0, len(block)
	for left < right {
		mid := left + (right-left)/2
		if domain.CompareFlatPoint(block[mid], point) < 0 {
			left = mid + 1
		} else {
			right = mid
		}
	}
	return left
}

func (p *pagePointBlocks) split(index int) {
	block := p.blocks[index]
	mid := len(block) / 2
	left := append([]domain.FlatPoint(nil), block[:mid]...)
	right := append([]domain.FlatPoint(nil), block[mid:]...)
	p.blocks[index] = left
	p.blocks = append(p.blocks, nil)
	copy(p.blocks[index+2:], p.blocks[index+1:])
	p.blocks[index+1] = right
}

func (p *pagePointBlocks) removeCommand(cmdID string) bool {
	changed := false
	nextBlocks := p.blocks[:0]
	for _, block := range p.blocks {
		next := block[:0]
		for _, point := range block {
			if point.CmdID == cmdID {
				changed = true
				continue
			}
			next = append(next, point)
		}
		if len(next) > 0 {
			nextBlocks = append(nextBlocks, next)
		}
	}
	p.blocks = nextBlocks
	p.mergeSmallBlocks()
	return changed
}

func (p *pagePointBlocks) mergeSmallBlocks() {
	if len(p.blocks) < 2 {
		return
	}
	merged := p.blocks[:0]
	for _, block := range p.blocks {
		if len(block) == 0 {
			continue
		}
		lastIndex := len(merged) - 1
		if lastIndex >= 0 && len(merged[lastIndex])+len(block) <= pointBlockSize {
			merged[lastIndex] = append(merged[lastIndex], block...)
			continue
		}
		merged = append(merged, block)
	}
	p.blocks = merged
}

func (p *pagePointBlocks) flatten() []domain.FlatPoint {
	out := make([]domain.FlatPoint, 0, p.len())
	return p.appendTo(out)
}

func (p *pagePointBlocks) appendTo(out []domain.FlatPoint) []domain.FlatPoint {
	for _, block := range p.blocks {
		out = append(out, block...)
	}
	return out
}

func (p *pagePointBlocks) empty() bool {
	return len(p.blocks) == 0
}

func (p *pagePointBlocks) len() int {
	total := 0
	for _, block := range p.blocks {
		total += len(block)
	}
	return total
}
