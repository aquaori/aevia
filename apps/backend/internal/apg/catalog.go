package apg

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	ManifestVersion  = 1
	ManifestVersion2 = 2
	APIVersion       = 1

	MaxV1PackageBytes     int64 = 256 * 1024
	MaxPackageBytes       int64 = 1024 * 1024
	MaxManifestBytes      int64 = 64 * 1024
	MaxProgramBytes       int64 = 128 * 1024
	MaxAssetBytes         int64 = 256 * 1024
	MaxExpandedBytes      int64 = 1024 * 1024
	MaxAssetCount               = 64
	MaxPackageEntries           = 67
	MaxStateSchemaVersion       = 1000
	MaxCatalogPlugins           = 256
	MaxPalettesPerPlugin        = 64
	MaxBrushesPerPlugin         = 64
	MaxColorsPerPalette         = 64
	MaxIDLength                 = 128
	MaxTextLength               = 256
	MaxBrushSize                = 30
)

var (
	idPattern      = regexp.MustCompile(`^[a-z0-9]+(?:[.-][a-z0-9]+)*$`)
	versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	colorPattern   = regexp.MustCompile(`(?i)^#[0-9a-f]{6}$`)
)

type Manifest struct {
	ManifestVersion int      `json:"manifestVersion"`
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Version         string   `json:"version"`
	Scope           string   `json:"scope"`
	APIVersion      int      `json:"apiVersion,omitempty"`
	Permissions     []string `json:"permissions,omitempty"`
	// StateSchemaVersion versions the shared-state value written under this plugin id. It is
	// optional: 0 means the plugin predates state versioning and can never downgrade stored state.
	StateSchemaVersion int         `json:"stateSchemaVersion,omitempty"`
	Main               string      `json:"main,omitempty"`
	Contributes        Contributes `json:"contributes"`
}

type Contributes struct {
	Palettes []Palette `json:"palettes,omitempty"`
	Brushes  []Brush   `json:"brushes,omitempty"`
	Commands []Command `json:"commands,omitempty"`
}

type Command struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Shortcut string `json:"shortcut,omitempty"`
	Resource string `json:"resource,omitempty"`
}

type Palette struct {
	ID     string   `json:"id"`
	Label  string   `json:"label"`
	Colors []string `json:"colors"`
}

type Brush struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Base    string   `json:"base"`
	Color   *string  `json:"color,omitempty"`
	Size    *float64 `json:"size,omitempty"`
	Opacity *float64 `json:"opacity,omitempty"`
}

type Catalog struct {
	Version  int             `json:"version"`
	Revision string          `json:"revision"`
	Plugins  []CatalogPlugin `json:"plugins"`
}

type CatalogPlugin struct {
	Manifest Manifest `json:"manifest"`
	Enabled  bool     `json:"enabled"`
	Program  string   `json:"program,omitempty"`
	Digest   string   `json:"digest,omitempty"`
	SignedBy string   `json:"signedBy,omitempty"`
}

func ReadPackage(path string) (Manifest, error) {
	pkg, err := ReadPackageBundle(path)
	if err != nil {
		return Manifest{}, err
	}
	return pkg.Manifest, nil
}

// ValidateManifestJSON validates a manifest contract without requiring a
// ZIP container. ReadPackage uses this same path so CLI and catalog validation
// cannot drift.
func ValidateManifestJSON(data []byte) (Manifest, error) {
	if int64(len(data)) > MaxManifestBytes {
		return Manifest{}, fmt.Errorf("manifest exceeds %d bytes", MaxManifestBytes)
	}
	if err := validateUniqueJSONKeys(data); err != nil {
		return Manifest{}, err
	}
	var manifest Manifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode manifest: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return Manifest{}, err
	}
	if err := validateManifestShape(data); err != nil {
		return Manifest{}, err
	}
	if err := validateManifest(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func validateManifestShape(data []byte) error {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return fmt.Errorf("decode manifest shape: %w", err)
	}
	for _, field := range []string{"manifestVersion", "id", "name", "version", "scope", "contributes"} {
		if raw, ok := root[field]; !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("%s is required", field)
		}
	}
	var contributes map[string]json.RawMessage
	if err := json.Unmarshal(root["contributes"], &contributes); err != nil || contributes == nil {
		return errors.New("contributes must be an object")
	}
	if err := validateContributionArrayShape(contributes, "palettes", []string{"id", "label", "colors"}); err != nil {
		return err
	}
	if err := validateContributionArrayShape(contributes, "brushes", []string{"id", "label", "base"}); err != nil {
		return err
	}
	if err := validateContributionArrayShape(contributes, "commands", []string{"id", "label"}); err != nil {
		return err
	}
	return nil
}

func validateUniqueJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := walkJSONValue(decoder, "$"); err != nil {
		return err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return err
	}
	return nil
}

func walkJSONValue(decoder *json.Decoder, path string) error {
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("decode manifest structure: %w", err)
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]string{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return fmt.Errorf("decode object key at %s: %w", path, err)
			}
			key, ok := keyToken.(string)
			if !ok {
				return fmt.Errorf("invalid object key at %s", path)
			}
			folded := strings.ToLower(key)
			if previous, exists := seen[folded]; exists {
				return fmt.Errorf("duplicate JSON key at %s: %q conflicts with %q", path, key, previous)
			}
			seen[folded] = key
			if err := walkJSONValue(decoder, path+"."+key); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("decode object end at %s: %w", path, err)
		}
		if end != json.Delim('}') {
			return fmt.Errorf("decode object end at %s", path)
		}
	case '[':
		index := 0
		for decoder.More() {
			if err := walkJSONValue(decoder, fmt.Sprintf("%s[%d]", path, index)); err != nil {
				return err
			}
			index++
		}
		end, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("decode array end at %s: %w", path, err)
		}
		if end != json.Delim(']') {
			return fmt.Errorf("decode array end at %s", path)
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q at %s", delim, path)
	}
	return nil
}

func validateContributionArrayShape(contributes map[string]json.RawMessage, field string, required []string) error {
	raw, exists := contributes[field]
	if !exists {
		return nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return fmt.Errorf("%s must be an array when present", field)
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return fmt.Errorf("%s must be an array", field)
	}
	for i, entry := range entries {
		if entry == nil {
			return fmt.Errorf("%s[%d] must be an object", field, i)
		}
		for _, name := range required {
			value, ok := entry[name]
			if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return fmt.Errorf("%s[%d].%s is required", field, i, name)
			}
		}
		if field == "brushes" {
			for _, optional := range []string{"color", "size", "opacity"} {
				if value, ok := entry[optional]; ok && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					return fmt.Errorf("%s[%d].%s cannot be null", field, i, optional)
				}
			}
		}
	}
	return nil
}

func LoadCatalog(dir string) (Catalog, error) {
	return LoadCatalogWithTrust(dir, TrustStore{Version: 1, Keys: map[string]string{}}, TrustAllowUnsigned)
}

func LoadCatalogWithTrust(dir string, store TrustStore, policy TrustPolicy) (Catalog, error) {
	catalog := Catalog{Version: ManifestVersion, Plugins: []CatalogPlugin{}, Revision: hex.EncodeToString(sha256.New().Sum(nil))}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return catalog, nil
		}
		return Catalog{}, fmt.Errorf("read APG directory: %w", err)
	}

	paths := make([]string, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".apg") {
			continue
		}
		paths = append(paths, filepath.Join(dir, entry.Name()))
	}
	if len(paths) > MaxCatalogPlugins {
		return Catalog{}, fmt.Errorf("catalog exceeds %d enabled plugins", MaxCatalogPlugins)
	}
	sort.Strings(paths)

	seen := make(map[string]string, len(paths))
	for _, path := range paths {
		pkg, err := ReadPackageBundle(path)
		if err != nil {
			return Catalog{}, fmt.Errorf("%s: %w", filepath.Base(path), err)
		}
		if err := VerifyTrust(pkg, store, policy); err != nil {
			return Catalog{}, fmt.Errorf("%s: %w", filepath.Base(path), err)
		}
		manifest := pkg.Manifest
		if previous, exists := seen[manifest.ID]; exists {
			return Catalog{}, fmt.Errorf("duplicate plugin id %q in %s and %s", manifest.ID, previous, filepath.Base(path))
		}
		seen[manifest.ID] = filepath.Base(path)
		item := CatalogPlugin{Manifest: manifest, Enabled: true, Digest: pkg.Digest}
		if pkg.Program != nil {
			item.Program = string(pkg.Program)
		}
		if pkg.Signature != nil {
			item.SignedBy = pkg.Signature.KeyID
		}
		catalog.Plugins = append(catalog.Plugins, item)
	}
	sort.Slice(catalog.Plugins, func(i, j int) bool { return catalog.Plugins[i].Manifest.ID < catalog.Plugins[j].Manifest.ID })
	hash := sha256.New()
	for _, plugin := range catalog.Plugins {
		_, _ = hash.Write([]byte(plugin.Digest))
		_, _ = hash.Write([]byte("\x00" + plugin.SignedBy + "\x00"))
	}
	catalog.Revision = hex.EncodeToString(hash.Sum(nil))
	return catalog, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("manifest must contain one JSON object")
	}
	return fmt.Errorf("decode trailing manifest data: %w", err)
}

func validateManifest(manifest Manifest) error {
	if manifest.ManifestVersion != ManifestVersion && manifest.ManifestVersion != ManifestVersion2 {
		return fmt.Errorf("manifestVersion must be %d or %d", ManifestVersion, ManifestVersion2)
	}
	if err := validateID("id", manifest.ID); err != nil {
		return err
	}
	if err := validateText("name", manifest.Name); err != nil {
		return err
	}
	if !versionPattern.MatchString(manifest.Version) {
		return errors.New("version must match x.y.z")
	}
	if manifest.Scope != "system" && manifest.Scope != "user" {
		return errors.New("scope must be system or user")
	}
	if manifest.ManifestVersion == ManifestVersion {
		if manifest.APIVersion != 0 || len(manifest.Permissions) != 0 || manifest.Main != "" || len(manifest.Contributes.Commands) != 0 || manifest.StateSchemaVersion != 0 {
			return errors.New("manifestVersion 1 does not support apiVersion, permissions, main, or commands")
		}
	} else {
		if manifest.APIVersion != APIVersion {
			return fmt.Errorf("apiVersion must be %d", APIVersion)
		}
		if manifest.Main != "" && manifest.Main != "main.js" {
			return errors.New("main must be main.js")
		}
		if len(manifest.Contributes.Commands) > 0 && manifest.Main != "main.js" {
			return errors.New("commands require main main.js")
		}
	}
	if manifest.StateSchemaVersion < 0 || manifest.StateSchemaVersion > MaxStateSchemaVersion {
		return fmt.Errorf("stateSchemaVersion must be 0-%d", MaxStateSchemaVersion)
	}
	permissions := make(map[string]struct{}, len(manifest.Permissions))
	for _, permission := range manifest.Permissions {
		switch permission {
		case "scene.read", "scene.write", "ui.preview", "ui.download", "storage.shared":
		default:
			return fmt.Errorf("unsupported permission %q", permission)
		}
		if _, exists := permissions[permission]; exists {
			return fmt.Errorf("duplicate permission %q", permission)
		}
		permissions[permission] = struct{}{}
	}
	if len(manifest.Contributes.Palettes) > MaxPalettesPerPlugin {
		return fmt.Errorf("palettes exceed %d", MaxPalettesPerPlugin)
	}
	if len(manifest.Contributes.Brushes) > MaxBrushesPerPlugin {
		return fmt.Errorf("brushes exceed %d", MaxBrushesPerPlugin)
	}
	if manifest.Scope == "user" {
		if len(manifest.Contributes.Brushes) != 0 {
			return errors.New("user-scoped plugins cannot contribute brushes")
		}
		if _, writesScene := permissions["scene.write"]; writesScene {
			return errors.New("scene.write requires system scope")
		}
		if _, shared := permissions["storage.shared"]; shared {
			return errors.New("storage.shared requires system scope")
		}
	}
	if manifest.StateSchemaVersion != 0 {
		if _, shared := permissions["storage.shared"]; !shared {
			return errors.New("stateSchemaVersion requires storage.shared")
		}
	}
	if len(manifest.Contributes.Commands) > 64 {
		return errors.New("too many commands")
	}

	paletteIDs := make(map[string]struct{}, len(manifest.Contributes.Palettes))
	for i, palette := range manifest.Contributes.Palettes {
		if err := validateID(fmt.Sprintf("palettes[%d].id", i), palette.ID); err != nil {
			return err
		}
		if _, exists := paletteIDs[palette.ID]; exists {
			return fmt.Errorf("duplicate palette id %q", palette.ID)
		}
		paletteIDs[palette.ID] = struct{}{}
		if err := validateText(fmt.Sprintf("palettes[%d].label", i), palette.Label); err != nil {
			return err
		}
		if len(palette.Colors) == 0 {
			return fmt.Errorf("palettes[%d].colors must not be empty", i)
		}
		if len(palette.Colors) > MaxColorsPerPalette {
			return fmt.Errorf("palettes[%d].colors exceed %d", i, MaxColorsPerPalette)
		}
		for j, color := range palette.Colors {
			if !colorPattern.MatchString(color) {
				return fmt.Errorf("palettes[%d].colors[%d] must match #RRGGBB", i, j)
			}
		}
	}

	brushIDs := make(map[string]struct{}, len(manifest.Contributes.Brushes))
	for i, brush := range manifest.Contributes.Brushes {
		if err := validateID(fmt.Sprintf("brushes[%d].id", i), brush.ID); err != nil {
			return err
		}
		if _, exists := brushIDs[brush.ID]; exists {
			return fmt.Errorf("duplicate brush id %q", brush.ID)
		}
		brushIDs[brush.ID] = struct{}{}
		if err := validateText(fmt.Sprintf("brushes[%d].label", i), brush.Label); err != nil {
			return err
		}
		switch brush.Base {
		case "pen", "pencil", "highlighter":
		default:
			return fmt.Errorf("brushes[%d].base is invalid", i)
		}
		if brush.Color != nil && !colorPattern.MatchString(*brush.Color) {
			return fmt.Errorf("brushes[%d].color must match #RRGGBB", i)
		}
		if brush.Size != nil && (*brush.Size < 0.1 || *brush.Size > MaxBrushSize) {
			return fmt.Errorf("brushes[%d].size must be between 0.1 and %d", i, MaxBrushSize)
		}
		if brush.Opacity != nil && (*brush.Opacity < 0 || *brush.Opacity > 1) {
			return fmt.Errorf("brushes[%d].opacity must be between 0 and 1", i)
		}
	}
	commandIDs := make(map[string]struct{}, len(manifest.Contributes.Commands))
	for i, command := range manifest.Contributes.Commands {
		if err := validateID(fmt.Sprintf("commands[%d].id", i), command.ID); err != nil {
			return err
		}
		if _, exists := commandIDs[command.ID]; exists {
			return fmt.Errorf("duplicate command id %q", command.ID)
		}
		commandIDs[command.ID] = struct{}{}
		if err := validateText(fmt.Sprintf("commands[%d].label", i), command.Label); err != nil {
			return err
		}
		if command.Shortcut != "" && !regexp.MustCompile("^Alt\\+Shift\\+[0-9]$").MatchString(command.Shortcut) {
			return errors.New("command shortcut must be Alt+Shift+digit")
		}
		if command.Resource != "" && (manifest.Scope != "system" || !regexp.MustCompile("^assets/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\\.json$").MatchString(command.Resource)) {
			return errors.New("command resource must be a system JSON asset")
		}
	}
	return nil
}

func validateID(field, value string) error {
	if len(value) == 0 || len(value) > MaxIDLength || !idPattern.MatchString(value) {
		return fmt.Errorf("%s must be 1-%d lower-case dot/hyphen identifier characters", field, MaxIDLength)
	}
	return nil
}

func validateText(field, value string) error {
	if strings.TrimSpace(value) == "" || len(value) > MaxTextLength {
		return fmt.Errorf("%s must be 1-%d non-whitespace characters", field, MaxTextLength)
	}
	return nil
}
