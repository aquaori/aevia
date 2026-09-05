package domain

import (
	"encoding/json"
	"math"
	"sort"
	"time"
)

type Room struct {
	RoomID     string `json:"roomId"`
	Name       string `json:"name"`
	Password   string `json:"-"`
	CreatedAt  int64  `json:"createdAt"`
	TotalPage  int    `json:"totalPage"`
	DurableSeq uint64 `json:"durableSeq"`
}

type Point struct {
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	P       float64 `json:"p"`
	Lamport float64 `json:"lamport"`
}

type FlatPoint struct {
	X             float64 `json:"x"`
	Y             float64 `json:"y"`
	P             float64 `json:"p"`
	Lamport       float64 `json:"lamport"`
	CmdID         string  `json:"cmdId"`
	OrderOpID     string  `json:"orderOpId,omitempty"`
	PageID        int     `json:"pageId"`
	UserID        string  `json:"userId"`
	Tool          string  `json:"tool"`
	Color         string  `json:"color"`
	Size          float64 `json:"size"`
	StrokePattern string  `json:"strokePattern,omitempty"`
	IsDeleted     bool    `json:"isDeleted"`
	PointIndex    int     `json:"-"`
}

type Command = *CommandData

type CommandData struct {
	fields map[string]any
	points []Point
}

func NewCommand(fields map[string]any) Command {
	cmd := &CommandData{fields: make(map[string]any, len(fields))}
	for key, value := range fields {
		if key == "points" {
			continue
		}
		cmd.fields[key] = value
	}
	cmd.SetPoints(pointsFromValue(fields["points"]))
	return cmd
}

func (c *CommandData) Clone() Command {
	if c == nil {
		return nil
	}
	out := &CommandData{fields: make(map[string]any, len(c.fields)), points: append([]Point(nil), c.points...)}
	for key, value := range c.fields {
		out.fields[key] = value
	}
	return out
}

func (c *CommandData) Snapshot() Command {
	if c == nil {
		return nil
	}
	out := &CommandData{fields: make(map[string]any, len(c.fields)), points: append([]Point(nil), c.points...)}
	for key, value := range c.fields {
		out.fields[key] = snapshotValue(value)
	}
	return out
}

func snapshotValue(value any) any {
	switch v := value.(type) {
	case nil:
		return nil
	case Command:
		return v.Snapshot()
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = snapshotValue(item)
		}
		return out
	case []Point:
		return append([]Point(nil), v...)
	case []FlatPoint:
		return append([]FlatPoint(nil), v...)
	case []Command:
		out := make([]Command, len(v))
		for i, item := range v {
			out[i] = item.Snapshot()
		}
		return out
	case []map[string]any:
		out := make([]map[string]any, len(v))
		for i, item := range v {
			cloned := make(map[string]any, len(item))
			for key, value := range item {
				cloned[key] = snapshotValue(value)
			}
			out[i] = cloned
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = snapshotValue(item)
		}
		return out
	default:
		return value
	}
}

func (c *CommandData) Get(key string) any {
	if c == nil {
		return nil
	}
	if key == "points" {
		return c.points
	}
	return c.fields[key]
}

func (c *CommandData) Set(key string, value any) {
	if c == nil {
		return
	}
	if c.fields == nil {
		c.fields = make(map[string]any)
	}
	if key == "points" {
		c.SetPoints(pointsFromValue(value))
		return
	}
	c.fields[key] = value
}

func (c *CommandData) ID() string          { return String(c.Get("id")) }
func (c *CommandData) Type() string        { return String(c.Get("type")) }
func (c *CommandData) UserID() string      { return String(c.Get("userId")) }
func (c *CommandData) PageID() (int, bool) { return Int(c.Get("pageId")) }
func (c *CommandData) IsDeleted() bool     { return Bool(c.Get("isDeleted")) }

func (c *CommandData) SetIdentity(userID, roomID string) {
	c.Set("userId", userID)
	c.Set("roomId", roomID)
}

func (c *CommandData) Points() []Point {
	if c == nil {
		return nil
	}
	return c.points
}

func pointsFromValue(value any) []Point {
	switch points := value.(type) {
	case nil:
		return nil
	case []Point:
		return append([]Point(nil), points...)
	case []map[string]any:
		out := make([]Point, 0, len(points))
		for _, point := range points {
			out = append(out, Point{
				X:       FloatDefault(point["x"], 0),
				Y:       FloatDefault(point["y"], 0),
				P:       FloatDefault(point["p"], 0),
				Lamport: FloatDefault(point["lamport"], 0),
			})
		}
		return out
	case []any:
		out := make([]Point, 0, len(points))
		for _, point := range points {
			if mapped, ok := point.(map[string]any); ok {
				out = append(out, Point{
					X:       FloatDefault(mapped["x"], 0),
					Y:       FloatDefault(mapped["y"], 0),
					P:       FloatDefault(mapped["p"], 0),
					Lamport: FloatDefault(mapped["lamport"], 0),
				})
			}
		}
		return out
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var points []Point
	if json.Unmarshal(bytes, &points) != nil {
		return nil
	}
	return points
}

func (c *CommandData) SetPoints(points []Point) {
	if c == nil {
		return
	}
	c.points = append([]Point(nil), points...)
}

func (c *CommandData) Payload() ([]byte, error) {
	return json.Marshal(c)
}

func (c *CommandData) MarshalJSON() ([]byte, error) {
	if c == nil {
		return []byte("null"), nil
	}
	out := make(map[string]any, len(c.fields)+1)
	for key, value := range c.fields {
		out[key] = value
	}
	if c.points != nil {
		out["points"] = c.points
	}
	return json.Marshal(out)
}

func (c *CommandData) UnmarshalJSON(payload []byte) error {
	var fields map[string]any
	if err := json.Unmarshal(payload, &fields); err != nil {
		return err
	}
	cmd := NewCommand(fields)
	c.fields = cmd.fields
	c.points = cmd.points
	return nil
}

func CommandFromPayload(payload []byte) (Command, error) {
	var cmd CommandData
	err := json.Unmarshal(payload, &cmd)
	if err != nil {
		return nil, err
	}
	return &cmd, nil
}

func FlattenCommand(cmd Command) []FlatPoint {
	return FlattenCommandRange(cmd, 0)
}

func FlattenCommandRange(cmd Command, startIndex int) []FlatPoint {
	if cmd.Type() != "path" {
		return nil
	}
	id := cmd.ID()
	pageID, ok := cmd.PageID()
	if id == "" || !ok || pageID < 0 {
		return nil
	}
	points := cmd.Points()
	if startIndex < 0 {
		startIndex = 0
	}
	if len(points) == 0 || startIndex >= len(points) {
		return nil
	}
	tool := StringDefault(cmd.Get("tool"), "pen")
	color := StringDefault(cmd.Get("color"), "#000000")
	size := FloatDefault(cmd.Get("size"), 3)
	userID := cmd.UserID()
	deleted := cmd.IsDeleted()
	out := make([]FlatPoint, 0, len(points)-startIndex)
	for i := startIndex; i < len(points); i++ {
		p := points[i]
		out = append(out, FlatPoint{
			X: p.X, Y: p.Y, P: p.P, Lamport: p.Lamport,
			CmdID: id, PageID: pageID, UserID: userID, Tool: tool,
			Color: color, Size: size, IsDeleted: deleted, PointIndex: i,
		})
	}
	return out
}

// ScenePathFragment is the transport-level point projection of a V2 path
// operation. It deliberately contains no geometry-derived state: the backend
// only exposes the already ordered samples through the existing render stream.
type ScenePathFragment struct {
	OperationID   string
	ElementID     string
	UserID        string
	PageID        int
	Lamport       float64
	SourceStart   int
	Points        []Point
	Tool          string
	Color         string
	Size          float64
	StrokePattern string
	IsCreate      bool
}

func ScenePathFragmentFromCommand(cmd Command) (ScenePathFragment, bool) {
	if cmd == nil || cmd.Type() != "scene-op" {
		return ScenePathFragment{}, false
	}
	operation, ok := cmd.Get("sceneOperation").(map[string]any)
	if !ok {
		return ScenePathFragment{}, false
	}
	payload, ok := operation["payload"].(map[string]any)
	if !ok {
		return ScenePathFragment{}, false
	}
	fragment := ScenePathFragment{
		OperationID: String(operation["opId"]),
		ElementID:   String(operation["elementId"]),
		UserID:      cmd.UserID(),
		PageID:      IntDefault(operation["pageId"], -1),
		Lamport:     FloatDefault(operation["lamport"], 0),
		Tool:        "pen",
		Color:       "#000000",
		Size:        3,
	}
	if fragment.OperationID == "" || fragment.ElementID == "" || fragment.PageID < 0 {
		return ScenePathFragment{}, false
	}

	switch String(operation["kind"]) {
	case "element.create":
		descriptor, ok := payload["descriptor"].(map[string]any)
		if !ok || String(descriptor["elementKind"]) != "path" || String(descriptor["recipeId"]) != "stroke" {
			return ScenePathFragment{}, false
		}
		style, _ := descriptor["style"].(map[string]any)
		fragment.IsCreate = true
		fragment.Tool = StringDefault(descriptor["toolId"], "pen")
		fragment.Color = StringDefault(style["color"], "#000000")
		fragment.Size = FloatDefault(style["size"], 3)
		fragment.StrokePattern = StringDefault(style["strokePattern"], "solid")
		fragment.Points = pointsFromValue(payload["points"])
		return fragment, true
	case "element.append":
		fragment.SourceStart = IntDefault(payload["sourceStart"], 0)
		fragment.Points = pointsFromValue(payload["points"])
		return fragment, true
	default:
		return ScenePathFragment{}, false
	}
}

func CompareFlatPoint(a, b FlatPoint) int {
	if a.Lamport < b.Lamport {
		return -1
	}
	if a.Lamport > b.Lamport {
		return 1
	}
	aOrderID := a.OrderOpID
	if aOrderID == "" {
		aOrderID = a.CmdID
	}
	bOrderID := b.OrderOpID
	if bOrderID == "" {
		bOrderID = b.CmdID
	}
	if aOrderID < bOrderID {
		return -1
	}
	if aOrderID > bOrderID {
		return 1
	}
	if a.PointIndex < b.PointIndex {
		return -1
	}
	if a.PointIndex > b.PointIndex {
		return 1
	}
	return 0
}

func SortFlatPoints(points []FlatPoint) {
	sort.Slice(points, func(i, j int) bool { return CompareFlatPoint(points[i], points[j]) < 0 })
}

func SortCommands(commands []Command) {
	sort.Slice(commands, func(i, j int) bool {
		leftLamport := FloatDefault(commands[i].Get("lamport"), 0)
		rightLamport := FloatDefault(commands[j].Get("lamport"), 0)
		if leftLamport != rightLamport {
			return leftLamport < rightLamport
		}
		return commands[i].ID() < commands[j].ID()
	})
}

func String(v any) string {
	s, _ := v.(string)
	return s
}

func StringDefault(v any, fallback string) string {
	if s := String(v); s != "" {
		return s
	}
	return fallback
}

func Bool(v any) bool {
	b, _ := v.(bool)
	return b
}

func Int(v any) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case int64:
		return int(x), true
	case uint64:
		return int(x), true
	case uint:
		return int(x), true
	case float64:
		if math.Trunc(x) == x {
			return int(x), true
		}
	}
	return 0, false
}

func IntDefault(v any, fallback int) int {
	if value, ok := Int(v); ok {
		return value
	}
	return fallback
}

func FloatDefault(v any, fallback float64) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int:
		return float64(x)
	case int64:
		return float64(x)
	}
	return fallback
}

func NowMillis() int64 { return time.Now().UnixMilli() }
