package apg

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

type Package struct {
	Manifest  Manifest
	Program   []byte
	Assets    map[string][]byte
	Digest    string
	Signature *PackageSignature
	entries   map[string][]byte
}

type PackageSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Digest    string `json:"digest"`
	Signature string `json:"signature"`
}

type TrustPolicy string

const (
	TrustAllowUnsigned TrustPolicy = "allow-unsigned"
	TrustRequireSigned TrustPolicy = "require-signed"
)

type TrustStore struct {
	Version int               `json:"version"`
	Keys    map[string]string `json:"keys"`
}

func ReadPackageBundle(packagePath string) (Package, error) {
	if filepath.Ext(packagePath) != ".apg" {
		return Package{}, errors.New("package must use the .apg extension")
	}
	info, err := os.Lstat(packagePath)
	if err != nil {
		return Package{}, fmt.Errorf("stat package: %w", err)
	}
	if !info.Mode().IsRegular() {
		return Package{}, errors.New("package is not a regular file")
	}
	if info.Size() > MaxPackageBytes {
		return Package{}, fmt.Errorf("package exceeds %d bytes", MaxPackageBytes)
	}
	zr, err := zip.OpenReader(packagePath)
	if err != nil {
		return Package{}, fmt.Errorf("open package zip: %w", err)
	}
	defer zr.Close()
	if len(zr.File) == 0 || len(zr.File) > MaxPackageEntries {
		return Package{}, fmt.Errorf("package entry count must be between 1 and %d", MaxPackageEntries)
	}

	entries := make(map[string][]byte, len(zr.File))
	var expanded int64
	for _, entry := range zr.File {
		name := entry.Name
		if !safeEntryName(name) || entry.FileInfo().IsDir() || !entry.Mode().IsRegular() {
			return Package{}, fmt.Errorf("invalid package entry %q", name)
		}
		if _, exists := entries[name]; exists {
			return Package{}, fmt.Errorf("duplicate package entry %q", name)
		}
		limit := MaxAssetBytes
		switch name {
		case "manifest.json":
			limit = MaxManifestBytes
		case "main.js":
			limit = MaxProgramBytes
		case "signature.json":
			limit = MaxManifestBytes
		}
		if int64(entry.UncompressedSize64) > limit {
			if name == "manifest.json" {
				return Package{}, fmt.Errorf("manifest exceeds %d bytes", limit)
			}
			return Package{}, fmt.Errorf("%s exceeds %d bytes", name, limit)
		}
		rc, err := entry.Open()
		if err != nil {
			return Package{}, fmt.Errorf("open %s: %w", name, err)
		}
		data, readErr := io.ReadAll(io.LimitReader(rc, limit+1))
		closeErr := rc.Close()
		if readErr != nil {
			return Package{}, fmt.Errorf("read %s: %w", name, readErr)
		}
		if closeErr != nil {
			return Package{}, fmt.Errorf("close %s: %w", name, closeErr)
		}
		if int64(len(data)) > limit {
			if name == "manifest.json" {
				return Package{}, fmt.Errorf("manifest exceeds %d bytes", limit)
			}
			return Package{}, fmt.Errorf("%s exceeds %d bytes", name, limit)
		}
		expanded += int64(len(data))
		if expanded > MaxExpandedBytes {
			return Package{}, fmt.Errorf("expanded package exceeds %d bytes", MaxExpandedBytes)
		}
		entries[name] = data
	}

	manifestJSON, exists := entries["manifest.json"]
	if !exists {
		return Package{}, errors.New("package is missing manifest.json")
	}
	manifest, err := ValidateManifestJSON(manifestJSON)
	if err != nil {
		return Package{}, err
	}
	if manifest.ManifestVersion == ManifestVersion {
		if info.Size() > MaxV1PackageBytes {
			return Package{}, fmt.Errorf("v1 package exceeds %d bytes", MaxV1PackageBytes)
		}
		if len(entries) != 1 {
			return Package{}, errors.New("manifestVersion 1 package must contain exactly manifest.json")
		}
	} else if err := validateV2Entries(entries, manifest); err != nil {
		return Package{}, err
	}

	digestBytes := digestEntries(entries)
	pkg := Package{
		Manifest: manifest,
		Assets:   map[string][]byte{},
		Digest:   hex.EncodeToString(digestBytes[:]),
		entries:  entries,
	}
	if program, exists := entries["main.js"]; exists {
		pkg.Program = append([]byte(nil), program...)
	}
	for name, data := range entries {
		if strings.HasPrefix(name, "assets/") {
			pkg.Assets[name] = append([]byte(nil), data...)
		}
	}
	if rawSignature, exists := entries["signature.json"]; exists {
		var signature PackageSignature
		decoder := json.NewDecoder(strings.NewReader(string(rawSignature)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&signature); err != nil {
			return Package{}, fmt.Errorf("decode signature.json: %w", err)
		}
		if signature.Algorithm != "ed25519" || signature.KeyID == "" || signature.Digest == "" || signature.Signature == "" {
			return Package{}, errors.New("signature.json is incomplete or unsupported")
		}
		if !strings.EqualFold(signature.Digest, pkg.Digest) {
			return Package{}, errors.New("signature digest does not match package digest")
		}
		pkg.Signature = &signature
	}
	return pkg, nil
}

func validateV2Entries(entries map[string][]byte, manifest Manifest) error {
	assetCount := 0
	for name := range entries {
		switch name {
		case "manifest.json", "main.js", "signature.json":
		default:
			if !strings.HasPrefix(name, "assets/") {
				return fmt.Errorf("manifestVersion 2 package contains unsupported entry %q", name)
			}
			assetCount++
		}
	}
	if assetCount > MaxAssetCount {
		return fmt.Errorf("asset count exceeds %d", MaxAssetCount)
	}
	if assetCount > 0 && manifest.Scope != "system" {
		return errors.New("shared assets require system scope")
	}
	for _, command := range manifest.Contributes.Commands {
		if command.Resource == "" {
			continue
		}
		data, exists := entries[command.Resource]
		if !exists || len(data) > 16384 || !json.Valid(data) {
			return errors.New("invalid command resource")
		}
	}
	_, hasProgram := entries["main.js"]
	if manifest.Main == "main.js" && !hasProgram {
		return errors.New("manifest main requires main.js package entry")
	}
	if manifest.Main == "" && hasProgram {
		return errors.New("main.js package entry requires manifest main")
	}
	return nil
}

func safeEntryName(name string) bool {
	if name == "" || strings.Contains(name, "\\") || strings.HasPrefix(name, "/") {
		return false
	}
	clean := path.Clean(name)
	return clean == name && clean != "." && !strings.HasPrefix(clean, "../")
}

func digestEntries(entries map[string][]byte) [32]byte {
	names := make([]string, 0, len(entries))
	for name := range entries {
		if name != "signature.json" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	h := sha256.New()
	var header [8]byte
	for _, name := range names {
		binary.BigEndian.PutUint64(header[:], uint64(len(name)))
		_, _ = h.Write(header[:])
		_, _ = h.Write([]byte(name))
		binary.BigEndian.PutUint64(header[:], uint64(len(entries[name])))
		_, _ = h.Write(header[:])
		_, _ = h.Write(entries[name])
	}
	var result [32]byte
	copy(result[:], h.Sum(nil))
	return result
}

func VerifyTrust(pkg Package, store TrustStore, policy TrustPolicy) error {
	// Fail closed: an empty policy is a configuration mistake, not "allow unsigned".
	if policy == "" {
		return errors.New("trust policy is required; set APG_TRUST_POLICY to allow-unsigned or require-signed")
	}
	if policy != TrustAllowUnsigned && policy != TrustRequireSigned {
		return fmt.Errorf("unsupported trust policy %q", policy)
	}
	if pkg.Signature == nil {
		if policy == TrustRequireSigned {
			if pkg.Manifest.ManifestVersion == ManifestVersion {
				return errors.New("manifestVersion 1 packages cannot be signed; upgrade to manifestVersion 2")
			}
			return errors.New("package signature is required")
		}
		return nil
	}
	encodedKey, exists := store.Keys[pkg.Signature.KeyID]
	if !exists {
		return fmt.Errorf("signing key %q is not trusted", pkg.Signature.KeyID)
	}
	publicKey, err := base64.StdEncoding.DecodeString(encodedKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("trusted key %q is invalid", pkg.Signature.KeyID)
	}
	signature, err := base64.StdEncoding.DecodeString(pkg.Signature.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("package signature encoding is invalid")
	}
	digest, err := hex.DecodeString(pkg.Digest)
	if err != nil || len(digest) != sha256.Size {
		return errors.New("package digest is invalid")
	}
	if !ed25519.Verify(ed25519.PublicKey(publicKey), digest, signature) {
		return errors.New("package signature verification failed")
	}
	return nil
}

func LoadTrustStore(storePath string) (TrustStore, error) {
	if strings.TrimSpace(storePath) == "" {
		return TrustStore{Version: 1, Keys: map[string]string{}}, nil
	}
	data, err := os.ReadFile(storePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return TrustStore{Version: 1, Keys: map[string]string{}}, nil
		}
		return TrustStore{}, err
	}
	var store TrustStore
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&store); err != nil {
		return TrustStore{}, fmt.Errorf("decode trust store: %w", err)
	}
	if store.Version != 1 {
		return TrustStore{}, errors.New("trust store version must be 1")
	}
	if store.Keys == nil {
		store.Keys = map[string]string{}
	}
	for keyID, encoded := range store.Keys {
		if err := validateID("trust key id", keyID); err != nil {
			return TrustStore{}, err
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			return TrustStore{}, fmt.Errorf("trusted key %q is not a base64 Ed25519 public key", keyID)
		}
	}
	return store, nil
}

func SignPackage(inputPath, outputPath, keyID string, privateKey ed25519.PrivateKey) error {
	if len(privateKey) != ed25519.PrivateKeySize {
		return errors.New("invalid Ed25519 private key")
	}
	if err := validateID("keyId", keyID); err != nil {
		return err
	}
	pkg, err := ReadPackageBundle(inputPath)
	if err != nil {
		return err
	}
	if pkg.Manifest.ManifestVersion != ManifestVersion2 {
		return errors.New("manifestVersion 1 packages cannot be signed; upgrade to manifestVersion 2")
	}
	entries := make(map[string][]byte, len(pkg.entries)+1)
	for name, data := range pkg.entries {
		if name != "signature.json" {
			entries[name] = append([]byte(nil), data...)
		}
	}
	digest := digestEntries(entries)
	signature := PackageSignature{
		Algorithm: "ed25519",
		KeyID:     keyID,
		Digest:    hex.EncodeToString(digest[:]),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, digest[:])),
	}
	rawSignature, err := json.Marshal(signature)
	if err != nil {
		return err
	}
	entries["signature.json"] = rawSignature
	return writePackageEntries(outputPath, entries)
}

// PackPackage builds a deterministic APG package from manifestPath. For v2,
// main.js and assets/** are resolved relative to the manifest directory.
func PackPackage(manifestPath, outputPath string) error {
	manifestJSON, err := os.ReadFile(manifestPath)
	if err != nil {
		return err
	}
	manifest, err := ValidateManifestJSON(manifestJSON)
	if err != nil {
		return err
	}
	entries := map[string][]byte{"manifest.json": manifestJSON}
	if manifest.ManifestVersion == ManifestVersion2 {
		root := filepath.Dir(manifestPath)
		if manifest.Main == "main.js" {
			program, err := os.ReadFile(filepath.Join(root, "main.js"))
			if err != nil {
				return fmt.Errorf("read main.js: %w", err)
			}
			if int64(len(program)) > MaxProgramBytes {
				return fmt.Errorf("main.js exceeds %d bytes", MaxProgramBytes)
			}
			entries["main.js"] = program
		}
		assetsRoot := filepath.Join(root, "assets")
		if info, statErr := os.Stat(assetsRoot); statErr == nil && info.IsDir() {
			assetCount := 0
			err = filepath.WalkDir(assetsRoot, func(filePath string, entry os.DirEntry, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				if entry.IsDir() {
					return nil
				}
				if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
					return fmt.Errorf("asset %s must be a regular file", filePath)
				}
				assetCount++
				if assetCount > MaxAssetCount {
					return fmt.Errorf("asset count exceeds %d", MaxAssetCount)
				}
				rel, err := filepath.Rel(root, filePath)
				if err != nil {
					return err
				}
				name := filepath.ToSlash(rel)
				if !safeEntryName(name) || !strings.HasPrefix(name, "assets/") {
					return fmt.Errorf("invalid asset path %q", name)
				}
				data, err := os.ReadFile(filePath)
				if err != nil {
					return err
				}
				if int64(len(data)) > MaxAssetBytes {
					return fmt.Errorf("%s exceeds %d bytes", name, MaxAssetBytes)
				}
				entries[name] = data
				return nil
			})
			if err != nil {
				return err
			}
		} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
			return statErr
		}
	}
	return writePackageEntries(outputPath, entries)
}

func writePackageEntries(outputPath string, entries map[string][]byte) error {
	if filepath.Ext(outputPath) != ".apg" {
		return errors.New("output must end in .apg")
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(outputPath), ".apg-sign-*.apg")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	zw := zip.NewWriter(temp)
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		w, err := zw.Create(name)
		if err != nil {
			_ = zw.Close()
			_ = temp.Close()
			return err
		}
		if _, err := w.Write(entries[name]); err != nil {
			_ = zw.Close()
			_ = temp.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if _, err := ReadPackageBundle(tempPath); err != nil {
		return fmt.Errorf("validate signed package: %w", err)
	}
	if _, err := os.Lstat(outputPath); err == nil {
		return errors.New("output already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(tempPath, outputPath); err != nil {
		return err
	}
	return nil
}
