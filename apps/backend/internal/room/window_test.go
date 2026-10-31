package room

import (
	"reflect"
	"testing"
)

func TestNormalizePageIDClampsIntoRange(t *testing.T) {
	tests := []struct {
		name      string
		pageID    int
		totalPage int
		want      int
	}{
		{"negative clamps to the first page", -3, 4, 0},
		{"inside the range is unchanged", 2, 4, 2},
		{"the last page is allowed", 3, 4, 3},
		{"past the end clamps to the last page", 9, 4, 3},
		{"no page count leaves a valid id alone", 5, 0, 5},
		{"no page count still clamps negatives", -1, 0, 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := normalizePageID(test.pageID, test.totalPage); got != test.want {
				t.Fatalf("expected %d, got %d", test.want, got)
			}
		})
	}
}

func TestSanitizePageIDsDeduplicatesAndSorts(t *testing.T) {
	got := sanitizePageIDs([]int{3, 1, 3, -2, 9, 2, 1}, 4)
	want := []int{0, 1, 2, 3}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}

	// Duplicates created by clamping must collapse to a single entry.
	if got := sanitizePageIDs([]int{-1, 0, 0}, 2); !reflect.DeepEqual(got, []int{0}) {
		t.Fatalf("expected clamped duplicates to collapse, got %v", got)
	}

	// With no known page count every page id is out of range.
	if got := sanitizePageIDs([]int{0, 1}, 0); len(got) != 0 {
		t.Fatalf("expected no pages for totalPage 0, got %v", got)
	}

	if got := sanitizePageIDs(nil, 3); len(got) != 0 {
		t.Fatalf("expected nil for empty input, got %v", got)
	}
}

func TestInitPageIDsStopsAtTheEndOfTheRoom(t *testing.T) {
	if got := initPageIDs(1, 5, 2); !reflect.DeepEqual(got, []int{1, 2}) {
		t.Fatalf("expected [1 2], got %v", got)
	}
	// The preload window cannot run past the last page.
	if got := initPageIDs(4, 5, 3); !reflect.DeepEqual(got, []int{4}) {
		t.Fatalf("expected a truncated preload, got %v", got)
	}
	// A negative or oversized starting page is normalized first.
	if got := initPageIDs(-2, 3, 2); !reflect.DeepEqual(got, []int{0, 1}) {
		t.Fatalf("expected a normalized start, got %v", got)
	}
	if got := initPageIDs(99, 3, 1); !reflect.DeepEqual(got, []int{2}) {
		t.Fatalf("expected the last page for an oversized start, got %v", got)
	}
	if got := initPageIDs(0, 3, 0); len(got) != 0 {
		t.Fatalf("expected no preloaded pages for preload 0, got %v", got)
	}
}

func TestAdjacentPageIDsClipsAtBothEnds(t *testing.T) {
	if got := adjacentPageIDs(2, 5, 1); !reflect.DeepEqual(got, []int{1, 2, 3}) {
		t.Fatalf("expected a centered window, got %v", got)
	}
	if got := adjacentPageIDs(0, 5, 2); !reflect.DeepEqual(got, []int{0, 1, 2}) {
		t.Fatalf("expected the window to clip at the first page, got %v", got)
	}
	if got := adjacentPageIDs(4, 5, 2); !reflect.DeepEqual(got, []int{2, 3, 4}) {
		t.Fatalf("expected the window to clip at the last page, got %v", got)
	}
	// A radius larger than the room still yields every page exactly once.
	if got := adjacentPageIDs(2, 3, 10); !reflect.DeepEqual(got, []int{0, 1, 2}) {
		t.Fatalf("expected the whole room, got %v", got)
	}
}

func TestDiffPageIDs(t *testing.T) {
	load, unload := diffPageIDs([]int{0, 1, 2}, []int{1, 2, 3})
	if !reflect.DeepEqual(load, []int{3}) {
		t.Fatalf("expected page 3 to load, got %v", load)
	}
	if !reflect.DeepEqual(unload, []int{0}) {
		t.Fatalf("expected page 0 to unload, got %v", unload)
	}

	if load, unload := diffPageIDs(nil, []int{0}); !reflect.DeepEqual(load, []int{0}) || len(unload) != 0 {
		t.Fatalf("expected the initial window to load, got load=%v unload=%v", load, unload)
	}
	if load, unload := diffPageIDs([]int{0}, nil); len(load) != 0 || !reflect.DeepEqual(unload, []int{0}) {
		t.Fatalf("expected the window to unload on reset, got load=%v unload=%v", load, unload)
	}
	if load, unload := diffPageIDs([]int{0, 1}, []int{0, 1}); len(load) != 0 || len(unload) != 0 {
		t.Fatalf("expected no diff for identical windows, got load=%v unload=%v", load, unload)
	}
}
