package room

import "sort"

func normalizePageID(pageID int, totalPage int) int {
	if pageID < 0 {
		pageID = 0
	}
	if totalPage > 0 && pageID >= totalPage {
		return totalPage - 1
	}
	return pageID
}

func sanitizePageIDs(pageIDs []int, totalPage int) []int {
	seen := make(map[int]bool)
	var out []int
	for _, pageID := range pageIDs {
		normalized := normalizePageID(pageID, totalPage)
		if normalized >= 0 && normalized < totalPage && !seen[normalized] {
			seen[normalized] = true
			out = append(out, normalized)
		}
	}
	sort.Ints(out)
	return out
}

func initPageIDs(pageID, totalPage, preload int) []int {
	var ids []int
	start := normalizePageID(pageID, totalPage)
	for i := 0; i < preload; i++ {
		candidate := start + i
		if candidate >= totalPage {
			break
		}
		ids = append(ids, candidate)
	}
	return sanitizePageIDs(ids, totalPage)
}

func adjacentPageIDs(pageID, totalPage, radius int) []int {
	current := normalizePageID(pageID, totalPage)
	var ids []int
	for candidate := current - radius; candidate <= current+radius; candidate++ {
		ids = append(ids, candidate)
	}
	return sanitizePageIDs(ids, totalPage)
}

func diffPageIDs(prev, next []int) (load []int, unload []int) {
	prevSet := map[int]bool{}
	nextSet := map[int]bool{}
	for _, id := range prev {
		prevSet[id] = true
	}
	for _, id := range next {
		nextSet[id] = true
		if !prevSet[id] {
			load = append(load, id)
		}
	}
	for _, id := range prev {
		if !nextSet[id] {
			unload = append(unload, id)
		}
	}
	return load, unload
}
