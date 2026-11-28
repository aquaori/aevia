package apg

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

// The catalog is rebuilt on every request, so its cost is the deployment's per-request
// APG overhead. This benchmark packs and signs the official plugins once, then
// measures a full trust-verified catalog load, which is what GET /api/apg/catalog does.
func BenchmarkLoadCatalogOfficialPlugins(b *testing.B) {
	root, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "plugins", "official"))
	if err != nil {
		b.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		b.Fatal(err)
	}
	dir := b.TempDir()
	staging := filepath.Join(dir, ".staging")
	if err := os.MkdirAll(staging, 0o700); err != nil {
		b.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		b.Fatal(err)
	}
	store := TrustStore{Version: 1, Keys: map[string]string{"bench": base64.StdEncoding.EncodeToString(publicKey)}}
	plugins := 0
	for _, entry := range entries {
		manifestPath := filepath.Join(root, entry.Name(), "manifest.json")
		if _, err := os.Stat(manifestPath); err != nil {
			continue
		}
		unsigned := filepath.Join(staging, entry.Name()+".apg")
		if err := PackPackage(manifestPath, unsigned); err != nil {
			b.Fatal(err)
		}
		if err := SignPackage(unsigned, filepath.Join(dir, entry.Name()+".apg"), "bench", privateKey); err != nil {
			b.Fatal(err)
		}
		plugins++
	}
	if plugins != 7 {
		b.Fatalf("expected seven official plugins, packaged %d", plugins)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		catalog, err := LoadCatalogWithTrust(dir, store, TrustRequireSigned)
		if err != nil {
			b.Fatal(err)
		}
		if len(catalog.Plugins) != plugins {
			b.Fatalf("catalog plugins = %d", len(catalog.Plugins))
		}
	}
}
