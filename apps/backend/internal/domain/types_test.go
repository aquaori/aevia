package domain

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// Cross-runtime ordering contract.
//
// The fixture is shared verbatim with the frontend/shared TypeScript test
// packages/shared/src/protocol/orderVectors.spec.ts, which sorts the same
// vectors with compareCommandOrder / compareRenderOrder. ASCII ids only: the Go
// backend compares raw UTF-8 bytes while JavaScript compares UTF-16 code units,
// and those two orders are only guaranteed to agree for ASCII.
//
// Alignment notes:
//   - commands maps to FlatPoint with OrderOpID empty (so CompareFlatPoint falls
//     back to CmdID) and PointIndex 0 for every row. Under those conditions
//     CompareFlatPoint is exactly compareCommandOrder: lamport then id.
//   - renderKeys cannot be fed to CompareFlatPoint faithfully. The render key
//     splits ties into sourceIndex AND subIndex, while FlatPoint has a single
//     PointIndex, so any mapping would invent a relationship between the two
//     levels. This test instead asserts the weaker invariant that the Go
//     comparator never contradicts the fixture's lamport/opId prefix order.
const orderVectorsRelativePath = "../../../../packages/shared/src/protocol/__fixtures__/order-vectors.json"

type orderVectorsFixture struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Description   string                 `json:"description"`
	Commands      []orderCommandVector   `json:"commands"`
	RenderKeys    []orderRenderKeyVector `json:"renderKeys"`
}

type orderCommandVector struct {
	Labels        []string           `json:"labels"`
	ExpectedOrder []string           `json:"expectedOrder"`
	Items         []orderCommandItem `json:"items"`
}

type orderCommandItem struct {
	ID      string  `json:"id"`
	Lamport float64 `json:"lamport"`
}

type orderRenderKeyVector struct {
	Labels        []string             `json:"labels"`
	ExpectedOrder []string             `json:"expectedOrder"`
	Items         []orderRenderKeyItem `json:"items"`
}

type orderRenderKeyItem struct {
	Lamport     float64 `json:"lamport"`
	OpID        string  `json:"opId"`
	SourceIndex int     `json:"sourceIndex"`
	SubIndex    int     `json:"subIndex"`
}

func loadOrderVectors(t *testing.T) orderVectorsFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(orderVectorsRelativePath))
	if err != nil {
		t.Fatalf("read order vectors fixture: %v", err)
	}
	var fixture orderVectorsFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode order vectors fixture: %v", err)
	}
	return fixture
}

func TestOrderVectorsFixtureShape(t *testing.T) {
	fixture := loadOrderVectors(t)
	if fixture.SchemaVersion != 1 {
		t.Fatalf("expected schemaVersion 1, got %d", fixture.SchemaVersion)
	}
	if len(fixture.Commands) < 9 {
		t.Fatalf("expected at least 9 command vectors, got %d", len(fixture.Commands))
	}
	if len(fixture.RenderKeys) < 9 {
		t.Fatalf("expected at least 9 render-key vectors, got %d", len(fixture.RenderKeys))
	}
	for _, vector := range fixture.Commands {
		if len(vector.Labels) != len(vector.Items) || len(vector.ExpectedOrder) != len(vector.Items) {
			t.Fatalf("command vector is misaligned: labels=%d expected=%d items=%d",
				len(vector.Labels), len(vector.ExpectedOrder), len(vector.Items))
		}
		for _, item := range vector.Items {
			if item.ID == "" {
				t.Fatalf("command vector item is missing an id: %+v", vector)
			}
		}
	}
	for _, vector := range fixture.RenderKeys {
		if len(vector.Labels) != len(vector.Items) || len(vector.ExpectedOrder) != len(vector.Items) {
			t.Fatalf("render-key vector is misaligned: labels=%d expected=%d items=%d",
				len(vector.Labels), len(vector.ExpectedOrder), len(vector.Items))
		}
	}
}

func TestCompareFlatPointMatchesSharedOrderVectors(t *testing.T) {
	fixture := loadOrderVectors(t)
	for index, vector := range fixture.Commands {
		points := make([]FlatPoint, 0, len(vector.Items))
		for _, item := range vector.Items {
			// OrderOpID intentionally empty: CompareFlatPoint must fall back to CmdID
			// exactly like compareCommandOrder. PointIndex is unused on these vectors.
			points = append(points, FlatPoint{CmdID: item.ID, Lamport: item.Lamport, PointIndex: 0})
		}
		if len(points) != len(vector.ExpectedOrder) {
			t.Fatalf("vector %d: %d points but %d expected ids", index, len(points), len(vector.ExpectedOrder))
		}

		position := make(map[string]int, len(vector.ExpectedOrder))
		for positionIndex, id := range vector.ExpectedOrder {
			position[id] = positionIndex
		}

		// Pairwise direction must match the fixture's total order. This is the
		// strongest cross-runtime assertion: it makes a tie or an inverted pair
		// fail immediately instead of being masked by sort.
		for _, left := range points {
			for _, right := range points {
				got := CompareFlatPoint(left, right)
				want := 0
				switch {
				case position[left.CmdID] < position[right.CmdID]:
					want = -1
				case position[left.CmdID] > position[right.CmdID]:
					want = 1
				}
				if got != want {
					t.Fatalf("vector %d (%v): CompareFlatPoint(%q, %q) = %d, want %d",
						index, vector.Labels, left.CmdID, right.CmdID, got, want)
				}
			}
		}

		sorted := append([]FlatPoint(nil), points...)
		SortFlatPoints(sorted)
		gotOrder := make([]string, len(sorted))
		for i, point := range sorted {
			gotOrder[i] = point.CmdID
		}
		if len(gotOrder) != len(vector.ExpectedOrder) {
			t.Fatalf("vector %d: sorted %d points, want %d", index, len(gotOrder), len(vector.ExpectedOrder))
		}
		for i := range gotOrder {
			if gotOrder[i] != vector.ExpectedOrder[i] {
				t.Fatalf("vector %d: sorted order %v, want %v", index, gotOrder, vector.ExpectedOrder)
			}
		}
	}
}

// The Go comparator cannot represent render keys exactly: sourceIndex and
// subIndex are two tie-break levels, PointIndex is one integer. Assert the
// weaker, still valuable property that lamport/opId ordering never contradicts
// the frontend fixture.
func TestCompareFlatPointDoesNotContradictRenderOrderVectors(t *testing.T) {
	fixture := loadOrderVectors(t)
	for index, vector := range fixture.RenderKeys {
		points := make([]FlatPoint, 0, len(vector.Items))
		for _, item := range vector.Items {
			points = append(points, FlatPoint{
				Lamport:    item.Lamport,
				CmdID:      item.OpID,
				OrderOpID:  item.OpID,
				PointIndex: 0,
			})
		}
		for expectedIndex, label := range vector.ExpectedOrder {
			// Recover the item behind each label. Labels are parallel to items.
			itemIndex := -1
			for candidate := range vector.Labels {
				if vector.Labels[candidate] == label {
					itemIndex = candidate
					break
				}
			}
			if itemIndex < 0 {
				t.Fatalf("vector %d: expected label %q is missing from labels", index, label)
			}
			for later := expectedIndex + 1; later < len(vector.ExpectedOrder); later++ {
				laterLabel := vector.ExpectedOrder[later]
				laterIndex := -1
				for candidate := range vector.Labels {
					if vector.Labels[candidate] == laterLabel {
						laterIndex = candidate
						break
					}
				}
				if laterIndex < 0 {
					t.Fatalf("vector %d: expected label %q is missing from labels", index, laterLabel)
				}
				// CompareFlatPoint compares (lamport, orderOpId/cmdId) only for these
				// constructed points. 0 means "tied in the Go model" (the renderer's
				// sourceIndex/subIndex would decide), which is allowed; >0 would mean
				// Go disagrees with the cross-runtime golden order.
				if got := CompareFlatPoint(points[itemIndex], points[laterIndex]); got > 0 {
					t.Fatalf("vector %d: Go orders %q after %q, contradicting the render contract",
						index, label, laterLabel)
				}
			}
		}
	}
}

func TestCompareFlatPointOrderOpIDAndPointIndexTieBreaks(t *testing.T) {
	// A scene operation's order key is its opId, not its command id: the opId
	// ordering must win even when the command ids point the other way.
	operation := FlatPoint{CmdID: "cmd-z", OrderOpID: "op-a", Lamport: 1}
	otherOperation := FlatPoint{CmdID: "cmd-a", OrderOpID: "op-b", Lamport: 1}
	if got := CompareFlatPoint(operation, otherOperation); got != -1 {
		t.Fatalf("expected OrderOpID to be compared instead of CmdID, got %d", got)
	}

	// Empty OrderOpID falls back to CmdID.
	left := FlatPoint{CmdID: "cmd-a", Lamport: 1}
	right := FlatPoint{CmdID: "cmd-b", Lamport: 1}
	if got := CompareFlatPoint(left, right); got != -1 {
		t.Fatalf("expected CmdID fallback ordering, got %d", got)
	}

	// Points of the same command are ordered by PointIndex.
	first := FlatPoint{CmdID: "cmd-a", Lamport: 1, PointIndex: 0}
	second := FlatPoint{CmdID: "cmd-a", Lamport: 1, PointIndex: 1}
	if got := CompareFlatPoint(first, second); got != -1 {
		t.Fatalf("expected PointIndex tie-break, got %d", got)
	}
	if got := CompareFlatPoint(second, first); got != 1 {
		t.Fatalf("expected reversed PointIndex tie-break, got %d", got)
	}
	if got := CompareFlatPoint(first, first); got != 0 {
		t.Fatalf("expected identical points to compare equal, got %d", got)
	}

	// SortFlatPoints must produce the same order as the pairwise comparator.
	points := []FlatPoint{
		{CmdID: "c", Lamport: 2, PointIndex: 0},
		{CmdID: "a", Lamport: 1, PointIndex: 1},
		{CmdID: "a", Lamport: 1, PointIndex: 0},
	}
	SortFlatPoints(points)
	got := []string{points[0].CmdID, points[1].CmdID, points[2].CmdID}
	if got[0] != "a" || got[1] != "a" || got[2] != "c" {
		t.Fatalf("unexpected sorted order: %v", got)
	}
	if points[0].PointIndex != 0 || points[1].PointIndex != 1 {
		t.Fatalf("expected PointIndex ascending within a command, got %+v", points)
	}
	if !sort.SliceIsSorted(points, func(i, j int) bool { return CompareFlatPoint(points[i], points[j]) < 0 }) {
		t.Fatal("SortFlatPoints output is not sorted by CompareFlatPoint")
	}
}

func TestOrderVectorsRetainKnownEdgeCases(t *testing.T) {
	fixture := loadOrderVectors(t)
	commandIDs := make(map[string]bool)
	for _, vector := range fixture.Commands {
		for _, id := range vector.ExpectedOrder {
			commandIDs[id] = true
		}
	}
	for _, id := range []string{"A", "a", "ab", "cmd-1", "cmd-10", "cmd-2", "10", "9", "cmdA", "cmd_1"} {
		if !commandIDs[id] {
			t.Fatalf("fixture lost regression coverage for id %q", id)
		}
	}

	// Uppercase sorts before lowercase, prefixes sort first, and numeric
	// suffixes are compared lexically rather than numerically.
	expectBefore := func(earlier, later string) {
		t.Helper()
		for _, vector := range fixture.Commands {
			positions := make(map[string]int, len(vector.ExpectedOrder))
			for i, id := range vector.ExpectedOrder {
				positions[id] = i
			}
			earlierPos, hasEarlier := positions[earlier]
			laterPos, hasLater := positions[later]
			if !hasEarlier || !hasLater {
				continue
			}
			if earlierPos >= laterPos {
				t.Fatalf("vector %v: expected %q before %q", vector.Labels, earlier, later)
			}
			return
		}
		t.Fatalf("fixture has no vector containing both %q and %q", earlier, later)
	}
	expectBefore("A", "a")
	expectBefore("a", "ab")
	expectBefore("cmd-1", "cmd-10")
	expectBefore("cmd-10", "cmd-2")
	expectBefore("10", "9")
	expectBefore("cmd-1", "cmdA")
	expectBefore("cmdA", "cmd_1")
}
