package room

import (
	"sort"

	"collaborative-whiteboard/apps/go-backend/internal/domain"
)

const pointBlockSize = 2000

type PagePointIndex struct {
	version  int
	pages    map[int]*pagePointBlocks
	locators map[string]commandPointLocator
}

type commandPointLocator struct {
	pageID   int
	points   int
	deleted  bool
	lastTool string
}

type pagePointBlocks struct {
	blocks [][]domain.FlatPoint
}

func NewPagePointIndex(commands []domain.Command) *PagePointIndex {
	idx := &PagePointIndex{
		pages:    make(map[int]*pagePointBlocks),
		locators: make(map[string]commandPointLocator),
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
	points := cmd.Points()
	pageID, ok := cmd.PageID()
	if !ok || pageID < 0 {
		i.Remove(cmdID)
		return
	}
	deleted := cmd.IsDeleted()
	tool := domain.StringDefault(cmd.Get("tool"), "pen")
	if locator, exists := i.locators[cmdID]; exists && canAppendIndexPoints(locator, pageID, len(points), deleted, tool) {
		i.appendCommandPoints(cmd, locator.points)
		return
	}

	i.Remove(cmdID)
	flatPoints := domain.FlattenCommand(cmd)
	if len(flatPoints) == 0 {
		i.locators[cmdID] = commandPointLocator{pageID: pageID, points: len(points), deleted: deleted, lastTool: tool}
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
	i.locators[cmdID] = commandPointLocator{pageID: pageID, points: len(points), deleted: deleted, lastTool: tool}
	i.version++
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
	points := cmd.Points()
	if startIndex >= len(points) {
		return
	}
	flatPoints := domain.FlattenCommandRange(cmd, startIndex)
	if len(flatPoints) == 0 {
		i.locators[cmdID] = commandPointLocator{
			pageID:   domain.IntDefault(cmd.Get("pageId"), 0),
			points:   len(points),
			deleted:  cmd.IsDeleted(),
			lastTool: domain.StringDefault(cmd.Get("tool"), "pen"),
		}
		return
	}
	pageID := flatPoints[0].PageID
	i.ensurePage(pageID).insertMany(flatPoints)
	i.locators[cmdID] = commandPointLocator{
		pageID:   pageID,
		points:   len(points),
		deleted:  cmd.IsDeleted(),
		lastTool: domain.StringDefault(cmd.Get("tool"), "pen"),
	}
	i.version++
}

func (i *PagePointIndex) Remove(cmdID string) {
	changed := false
	if locator, ok := i.locators[cmdID]; ok {
		if page := i.pages[locator.pageID]; page != nil {
			if page.removeCommand(cmdID) {
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
		i.version++
	}
}

func (i *PagePointIndex) ClearAll() {
	if len(i.pages) > 0 {
		i.pages = make(map[int]*pagePointBlocks)
		i.locators = make(map[string]commandPointLocator)
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
