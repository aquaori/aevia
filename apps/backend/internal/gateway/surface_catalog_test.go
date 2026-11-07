package gateway

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

type featureSurfaceCatalog struct {
	SchemaVersion int              `json:"schemaVersion"`
	Obligations   []featureSurface `json:"obligations"`
}

type featureSurface struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Surface  string   `json:"surface"`
	State    string   `json:"state"`
	Oracle   string   `json:"oracle"`
	Evidence []string `json:"evidence"`
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve catalog test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", ".."))
}

func readFeatureSurfaceCatalog(t *testing.T) featureSurfaceCatalog {
	t.Helper()
	path := filepath.Join(repositoryRoot(t), "tests", "catalog", "feature-obligations.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read feature surface catalog: %v", err)
	}
	var catalog featureSurfaceCatalog
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatalf("decode feature surface catalog: %v", err)
	}
	return catalog
}

func TestFeatureSurfaceCatalogMatchesBackendSources(t *testing.T) {
	catalog := readFeatureSurfaceCatalog(t)
	if catalog.SchemaVersion != 1 || len(catalog.Obligations) == 0 {
		t.Fatalf("unsupported or empty feature catalog schema: version=%d obligations=%d", catalog.SchemaVersion, len(catalog.Obligations))
	}

	want := map[string]map[string]bool{"http": {}, "ws": {}, "scene": {}, "frontend": {}}
	ids := make(map[string]bool)
	validStates := map[string]bool{"obligation_verified": true, "partial": true, "uncovered": true, "rejection_contract_verified": true}
	goTests := backendTestFunctions(t)
	for _, surface := range catalog.Obligations {
		if surface.ID == "" || surface.Surface == "" || surface.Oracle == "" {
			t.Fatalf("catalog surface is missing its id, name, or oracle: %+v", surface)
		}
		if ids[surface.ID] {
			t.Fatalf("duplicate feature surface id %q", surface.ID)
		}
		ids[surface.ID] = true
		if _, ok := want[surface.Kind]; !ok {
			t.Fatalf("unsupported feature surface kind %q for %s", surface.Kind, surface.ID)
		}
		if !validStates[surface.State] {
			t.Fatalf("unsupported coverage state %q for %s", surface.State, surface.ID)
		}
		want[surface.Kind][surface.Surface] = true
		for _, ref := range surface.Evidence {
			kind, name, ok := strings.Cut(ref, ":")
			if !ok || name == "" {
				t.Fatalf("invalid evidence reference %q for %s", ref, surface.ID)
			}
			switch kind {
			case "go":
				if !goTests[name] {
					t.Fatalf("catalog evidence %q does not name an existing Go test", ref)
				}
			case "external":
			default:
				t.Fatalf("unsupported evidence reference kind %q for %s", kind, surface.ID)
			}
		}
	}

	root := repositoryRoot(t)
	sources := map[string]map[string]bool{
		"http": scanHTTPRoutes(t,
			filepath.Join(root, "apps", "backend", "internal", "gateway", "server.go"),
			filepath.Join(root, "apps", "backend", "internal", "gateway", "v2_placeholders.go"),
		),
		"ws":    scanClientEventTypes(t, filepath.Join(root, "apps", "backend", "internal", "room", "events.go")),
		"scene": scanSceneOperationKinds(t, filepath.Join(root, "apps", "backend", "internal", "gateway", "scene_validation.go")),
	}
	for kind, actual := range sources {
		if missing, stale := setDifference(actual, want[kind]); len(missing) > 0 || len(stale) > 0 {
			t.Errorf("%s feature catalog differs from backend source; unregistered=%v stale=%v", kind, missing, stale)
		}
	}
}

func TestV2PlaceholdersExplicitlyRejectUntilImplemented(t *testing.T) {
	catalog := readFeatureSurfaceCatalog(t)
	handler, _ := newTestGatewayAtPath(t, filepath.Join(t.TempDir(), "catalog.sqlite"))
	for _, surface := range catalog.Obligations {
		if surface.Kind != "http" || !strings.Contains(surface.Surface, " /v2/") {
			continue
		}
		if surface.State != "rejection_contract_verified" {
			t.Errorf("reserved route %s must record its explicit rejection contract", surface.Surface)
			continue
		}
		method, path, ok := strings.Cut(surface.Surface, " ")
		if !ok {
			t.Fatalf("invalid HTTP surface %q", surface.Surface)
		}
		path = strings.NewReplacer(
			"{roomId}", "room-1",
			"{userId}", "user-1",
			"{role}", "member",
		).Replace(path)
		request := httptest.NewRequest(method, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		var body struct {
			Code string `json:"code"`
			Msg  string `json:"msg"`
		}
		decodeErr := json.NewDecoder(response.Body).Decode(&body)
		if decodeErr != nil {
			t.Errorf("decode %s response: %v", surface.Surface, decodeErr)
			continue
		}
		if response.Code != http.StatusNotImplemented || body.Code != "NOT_IMPLEMENTED" || body.Msg == "" {
			t.Errorf("%s must explicitly reject as NOT_IMPLEMENTED, got status=%d body=%+v", surface.Surface, response.Code, body)
		}
	}
}

func backendTestFunctions(t *testing.T) map[string]bool {
	t.Helper()
	root := filepath.Join(repositoryRoot(t), "apps", "backend")
	functions := make(map[string]bool)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, parseErr := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if parseErr != nil {
			return parseErr
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if ok && function.Recv == nil && strings.HasPrefix(function.Name.Name, "Test") {
				functions[function.Name.Name] = true
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scan Go tests for catalog evidence: %v", err)
	}
	return functions
}

func parseBackendFile(t *testing.T, path string) *ast.File {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.AllErrors)
	if err != nil {
		t.Fatalf("parse backend source %s: %v", path, err)
	}
	return file
}

func scanHTTPRoutes(t *testing.T, paths ...string) map[string]bool {
	t.Helper()
	routes := make(map[string]bool)
	for _, path := range paths {
		file := parseBackendFile(t, path)
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "HandleFunc" {
				return true
			}
			literal, ok := call.Args[0].(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				t.Errorf("HTTP route in %s must be a string literal", path)
				return true
			}
			route, err := strconv.Unquote(literal.Value)
			if err != nil {
				t.Errorf("decode HTTP route in %s: %v", path, err)
				return true
			}
			if routes[route] {
				t.Errorf("duplicate HTTP route registration %q", route)
			}
			routes[route] = true
			return true
		})
	}
	return routes
}

func scanClientEventTypes(t *testing.T, path string) map[string]bool {
	t.Helper()
	file := parseBackendFile(t, path)
	events := make(map[string]bool)
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Name.Name != "handleClientEvent" {
			continue
		}
		ast.Inspect(function.Body, func(node ast.Node) bool {
			switchStmt, ok := node.(*ast.SwitchStmt)
			if !ok {
				return true
			}
			selector, ok := switchStmt.Tag.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "Type" {
				return true
			}
			identifier, ok := selector.X.(*ast.Ident)
			if !ok || identifier.Name != "msg" {
				return true
			}
			for _, statement := range switchStmt.Body.List {
				clause, ok := statement.(*ast.CaseClause)
				if !ok {
					continue
				}
				for _, expression := range clause.List {
					literal, ok := expression.(*ast.BasicLit)
					if !ok || literal.Kind != token.STRING {
						continue
					}
					event, err := strconv.Unquote(literal.Value)
					if err != nil {
						t.Errorf("decode websocket event %s: %v", literal.Value, err)
						continue
					}
					events[event] = true
				}
			}
			return false
		})
	}
	return events
}

func scanSceneOperationKinds(t *testing.T, path string) map[string]bool {
	t.Helper()
	file := parseBackendFile(t, path)
	kinds := make(map[string]bool)
	for _, declaration := range file.Decls {
		group, ok := declaration.(*ast.GenDecl)
		if !ok || group.Tok != token.VAR {
			continue
		}
		for _, specification := range group.Specs {
			value, ok := specification.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for index, name := range value.Names {
				if name.Name != "sceneKinds" || index >= len(value.Values) {
					continue
				}
				literal, ok := value.Values[index].(*ast.CompositeLit)
				if !ok {
					t.Fatalf("sceneKinds must remain a literal so its public kinds can be inventoried")
				}
				for _, element := range literal.Elts {
					entry, ok := element.(*ast.KeyValueExpr)
					if !ok {
						continue
					}
					key, ok := entry.Key.(*ast.BasicLit)
					if !ok || key.Kind != token.STRING {
						t.Errorf("sceneKinds key must be a string literal")
						continue
					}
					kind, err := strconv.Unquote(key.Value)
					if err != nil {
						t.Errorf("decode scene kind %s: %v", key.Value, err)
						continue
					}
					kinds[kind] = true
				}
			}
		}
	}
	return kinds
}

func setDifference(actual, expected map[string]bool) ([]string, []string) {
	var missing, stale []string
	for value := range actual {
		if !expected[value] {
			missing = append(missing, value)
		}
	}
	for value := range expected {
		if !actual[value] {
			stale = append(stale, value)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	return missing, stale
}

func TestCatalogSurfacePathsAreValidHTTPPatterns(t *testing.T) {
	catalog := readFeatureSurfaceCatalog(t)
	for _, surface := range catalog.Obligations {
		if surface.Kind != "http" {
			continue
		}
		method, path, ok := strings.Cut(surface.Surface, " ")
		if !ok || method == "" || !strings.HasPrefix(path, "/") {
			t.Errorf("invalid HTTP surface %q", surface.Surface)
			continue
		}
		if _, err := url.ParseRequestURI(path); err != nil {
			t.Errorf("invalid HTTP path in %q: %v", surface.Surface, err)
		}
	}
}
