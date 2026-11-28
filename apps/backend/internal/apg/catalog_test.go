package apg

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validManifest() Manifest {
	color := "#112233"
	size := 5.0
	opacity := 0.5
	return Manifest{
		ManifestVersion: 1,
		ID:              "acme.tools",
		Name:            "Acme Tools",
		Version:         "1.2.3",
		Scope:           "system",
		Contributes: Contributes{
			Palettes: []Palette{{ID: "brand", Label: "Brand", Colors: []string{"#AABBCC"}}},
			Brushes:  []Brush{{ID: "marker", Label: "Marker", Base: "pen", Color: &color, Size: &size, Opacity: &opacity}},
		},
	}
}

func writePackage(t *testing.T, path string, manifest any, extra map[string][]byte) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
	for name, body := range extra {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadPackageAcceptsStrictManifest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tools.apg")
	writePackage(t, path, validManifest(), nil)
	manifest, err := ReadPackage(path)
	if err != nil {
		t.Fatalf("ReadPackage: %v", err)
	}
	if manifest.ID != "acme.tools" || manifest.Contributes.Brushes[0].Base != "pen" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
}

func TestReadPackageRequiresAPGExtension(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tools.zip")
	writePackage(t, path, validManifest(), nil)
	if _, err := ReadPackage(path); err == nil {
		t.Fatal("expected non-.apg extension rejection")
	}
}

func TestReadPackageRejectsExtraZipEntryAndUnknownField(t *testing.T) {
	t.Run("extra zip entry", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "extra.apg")
		writePackage(t, path, validManifest(), map[string][]byte{"payload.js": []byte("no")})
		if _, err := ReadPackage(path); err == nil {
			t.Fatal("expected extra zip entry rejection")
		}
	})
	t.Run("unknown manifest field", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "unknown.apg")
		manifest := map[string]any{
			"manifestVersion": 1, "id": "acme.tools", "name": "Acme", "version": "1.0.0", "scope": "system",
			"contributes": map[string]any{}, "script": "payload.js",
		}
		writePackage(t, path, manifest, nil)
		if _, err := ReadPackage(path); err == nil {
			t.Fatal("expected unknown field rejection")
		}
	})
}

func TestReadPackageRejectsUnsafeArchiveMembers(t *testing.T) {
	for name, entry := range map[string]string{
		"parent traversal":   "../evil.json",
		"nested traversal":   "assets/../../evil.json",
		"absolute path":      "/tmp/evil.json",
		"backslash path":     `assets\evil.json`,
		"duplicate manifest": "manifest.json",
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "unsafe.apg")
			writePackage(t, path, validManifest(), map[string][]byte{entry: []byte("{}")})
			if _, err := ReadPackage(path); err == nil {
				t.Fatalf("expected rejection of %q", entry)
			}
		})
	}
	t.Run("directory entry", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "unsafe.apg")
		writeRawPackage(t, path, "assets/")
		if _, err := ReadPackage(path); err == nil {
			t.Fatal("expected rejection of a directory entry")
		}
	})
}

// writeRawPackage writes a package with the given manifest plus one extra bare entry name,
// which lets a test create members that writePackage would refuse to write.
func writeRawPackage(t *testing.T, path, entry string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	manifestWriter, err := zw.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(validManifest())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manifestWriter.Write(data); err != nil {
		t.Fatal(err)
	}
	if _, err := zw.CreateHeader(&zip.FileHeader{Name: entry, Method: zip.Store}); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadPackageRejectsMissingOrNullContractFields(t *testing.T) {
	tests := []struct {
		name     string
		manifest map[string]any
	}{
		{
			name: "missing contributes",
			manifest: map[string]any{
				"manifestVersion": 1, "id": "acme.tools", "name": "Acme", "version": "1.0.0", "scope": "system",
			},
		},
		{
			name: "null palettes",
			manifest: map[string]any{
				"manifestVersion": 1, "id": "acme.tools", "name": "Acme", "version": "1.0.0", "scope": "system",
				"contributes": map[string]any{"palettes": nil},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "bad.apg")
			writePackage(t, path, test.manifest, nil)
			if _, err := ReadPackage(path); err == nil {
				t.Fatal("expected strict shape rejection")
			}
		})
	}
}

func TestReadPackageRejectsContractViolations(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Manifest)
	}{
		{"uppercase id", func(m *Manifest) { m.ID = "Acme.Tools" }},
		{"repeated separator", func(m *Manifest) { m.ID = "acme..tools" }},
		{"mixed separators", func(m *Manifest) { m.ID = "acme.-tools" }},
		{"non-semver version", func(m *Manifest) { m.Version = "v1" }},
		{"user brush", func(m *Manifest) { m.Scope = "user" }},
		{"invalid base", func(m *Manifest) { m.Contributes.Brushes[0].Base = "spray" }},
		{"oversized brush", func(m *Manifest) { value := float64(MaxBrushSize) + 0.1; m.Contributes.Brushes[0].Size = &value }},
		{"invalid opacity", func(m *Manifest) { value := 1.1; m.Contributes.Brushes[0].Opacity = &value }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := validManifest()
			test.mutate(&manifest)
			path := filepath.Join(t.TempDir(), "bad.apg")
			writePackage(t, path, manifest, nil)
			if _, err := ReadPackage(path); err == nil {
				t.Fatal("expected manifest rejection")
			}
		})
	}
}

func TestValidateManifestJSONAcceptsCaseInsensitiveHexColor(t *testing.T) {
	manifest := validManifest()
	manifest.Contributes.Palettes[0].Colors[0] = "#aAbBcC"
	color := "#dDeEfF"
	manifest.Contributes.Brushes[0].Color = &color
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateManifestJSON(data); err != nil {
		t.Fatalf("expected mixed-case hex colors to validate: %v", err)
	}
}

func TestValidateManifestJSONRejectsDuplicateKeysCaseInsensitively(t *testing.T) {
	tests := []string{
		`{"manifestVersion":1,"id":"acme.tools","id":"other","name":"Acme","version":"1.0.0","scope":"system","contributes":{}}`,
		`{"manifestVersion":1,"id":"acme.tools","ID":"other","name":"Acme","version":"1.0.0","scope":"system","contributes":{}}`,
		`{"manifestVersion":1,"id":"acme.tools","name":"Acme","version":"1.0.0","scope":"system","contributes":{"palettes":[{"id":"brand","ID":"other","label":"Brand","colors":["#AABBCC"]}]}}`,
	}
	for _, raw := range tests {
		if _, err := ValidateManifestJSON([]byte(raw)); err == nil || !strings.Contains(err.Error(), "duplicate JSON key") {
			t.Fatalf("expected duplicate-key rejection for %s, got %v", raw, err)
		}
	}
}

func TestValidateManifestJSONBrushNumericBounds(t *testing.T) {
	for _, test := range []struct {
		name    string
		size    float64
		opacity float64
		valid   bool
	}{
		{"minimum size", 0.1, 0, true},
		{"native maximum", MaxBrushSize, 1, true},
		{"below size minimum", 0.09, 0.5, false},
		{"above native maximum", MaxBrushSize + 0.01, 0.5, false},
		{"negative opacity", 1, -0.01, false},
		{"opacity above one", 1, 1.01, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			manifest := validManifest()
			manifest.Contributes.Brushes[0].Size = &test.size
			manifest.Contributes.Brushes[0].Opacity = &test.opacity
			data, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			_, err = ValidateManifestJSON(data)
			if test.valid && err != nil {
				t.Fatalf("expected valid manifest: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("expected numeric bound rejection")
			}
		})
	}
}

func TestReadPackageEnforcesSizeLimits(t *testing.T) {
	t.Run("compressed package", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "huge.apg")
		if err := os.WriteFile(path, bytes.Repeat([]byte("x"), int(MaxPackageBytes)+1), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadPackage(path); err == nil || !strings.Contains(err.Error(), "package exceeds") {
			t.Fatalf("expected package size rejection, got %v", err)
		}
	})
	t.Run("uncompressed manifest", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "huge-manifest.apg")
		manifest := validManifest()
		manifest.Name = strings.Repeat("x", int(MaxManifestBytes))
		writePackage(t, path, manifest, nil)
		if _, err := ReadPackage(path); err == nil || !strings.Contains(err.Error(), "manifest exceeds") {
			t.Fatalf("expected manifest size rejection, got %v", err)
		}
	})
}

func TestLoadCatalogIgnoresDisabledAndFailsClosed(t *testing.T) {
	dir := t.TempDir()
	first := validManifest()
	writePackage(t, filepath.Join(dir, "one.apg"), first, nil)
	disabledDir := filepath.Join(dir, "disabled")
	if err := os.Mkdir(disabledDir, 0o700); err != nil {
		t.Fatal(err)
	}
	disabled := validManifest()
	disabled.ID = "disabled.plugin"
	writePackage(t, filepath.Join(disabledDir, "disabled.apg"), disabled, nil)

	catalog, err := LoadCatalog(dir)
	if err != nil {
		t.Fatalf("LoadCatalog: %v", err)
	}
	if len(catalog.Plugins) != 1 || catalog.Plugins[0].Manifest.ID != "acme.tools" || !catalog.Plugins[0].Enabled {
		t.Fatalf("unexpected catalog: %+v", catalog)
	}

	duplicate := validManifest()
	writePackage(t, filepath.Join(dir, "two.apg"), duplicate, nil)
	if _, err := LoadCatalog(dir); err == nil || !strings.Contains(err.Error(), "duplicate plugin id") {
		t.Fatalf("expected duplicate-id failure, got %v", err)
	}

	if err := os.Remove(filepath.Join(dir, "two.apg")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.apg"), []byte("not zip"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCatalog(dir); err == nil {
		t.Fatal("expected invalid enabled package to fail the whole catalog")
	}
}

func TestLoadCatalogEnforcesPluginLimit(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < MaxCatalogPlugins; i++ {
		manifest := validManifest()
		manifest.ID = "acme.plugin" + fmt.Sprintf("%03d", i)
		manifest.Contributes.Palettes[0].ID = "palette"
		writePackage(t, filepath.Join(dir, fmt.Sprintf("p%03d.apg", i)), manifest, nil)
	}
	catalog, err := LoadCatalog(dir)
	if err != nil {
		t.Fatalf("LoadCatalog at the limit: %v", err)
	}
	if len(catalog.Plugins) != MaxCatalogPlugins {
		t.Fatalf("expected %d plugins, got %d", MaxCatalogPlugins, len(catalog.Plugins))
	}
	if catalog.Plugins[0].Manifest.ID != "acme.plugin000" || catalog.Plugins[len(catalog.Plugins)-1].Manifest.ID != "acme.plugin255" {
		t.Fatalf("unexpected catalog ordering: %q..%q", catalog.Plugins[0].Manifest.ID, catalog.Plugins[len(catalog.Plugins)-1].Manifest.ID)
	}

	over := validManifest()
	over.ID = "acme.one.too.many"
	writePackage(t, filepath.Join(dir, "overflow.apg"), over, nil)
	if _, err := LoadCatalog(dir); err == nil || !strings.Contains(err.Error(), fmt.Sprintf("catalog exceeds %d enabled plugins", MaxCatalogPlugins)) {
		t.Fatalf("expected plugin-count rejection, got %v", err)
	}
}

func TestLoadCatalogMissingDirectoryIsEmpty(t *testing.T) {
	catalog, err := LoadCatalog(filepath.Join(t.TempDir(), "missing"))
	if err != nil {
		t.Fatalf("LoadCatalog: %v", err)
	}
	if catalog.Version != 1 || catalog.Plugins == nil || len(catalog.Plugins) != 0 {
		t.Fatalf("unexpected empty catalog: %+v", catalog)
	}
}
