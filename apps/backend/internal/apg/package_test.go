package apg

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSignedPackageTamperIsRejected(t *testing.T) {
	dir := t.TempDir()
	manifest := Manifest{
		ManifestVersion: ManifestVersion2,
		ID:              "acme.signed",
		Name:            "Signed",
		Version:         "1.0.0",
		Scope:           "system",
		APIVersion:      APIVersion,
		Main:            "main.js",
		Contributes:     Contributes{},
	}
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	unsigned := filepath.Join(dir, "unsigned.apg")
	if err := writePackageEntries(unsigned, map[string][]byte{
		"manifest.json": manifestJSON,
		"main.js":       []byte("export default {};\n"),
	}); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signed := filepath.Join(dir, "signed.apg")
	if err := SignPackage(unsigned, signed, "test", privateKey); err != nil {
		t.Fatal(err)
	}
	store := TrustStore{Version: 1, Keys: map[string]string{"test": base64.StdEncoding.EncodeToString(publicKey)}}
	pkg, err := ReadPackageBundle(signed)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyTrust(pkg, store, TrustRequireSigned); err != nil {
		t.Fatalf("signed package rejected: %v", err)
	}

	tampered := filepath.Join(dir, "tampered.apg")
	rewritePackageEntry(t, signed, tampered, "main.js", func(data []byte) []byte {
		data[0] ^= 0xff
		return data
	})
	if _, err := ReadPackageBundle(tampered); err == nil {
		t.Fatal("tampered package was accepted")
	} else if !strings.Contains(err.Error(), "digest") {
		t.Fatalf("tampered package rejected for the wrong reason: %v", err)
	}
}

func TestV1PackageCannotBeSigned(t *testing.T) {
	dir := t.TempDir()
	manifest := Manifest{
		ManifestVersion: ManifestVersion,
		ID:              "acme.v1",
		Name:            "Legacy",
		Version:         "1.0.0",
		Scope:           "user",
		Contributes:     Contributes{},
	}
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "v1.apg")
	if err := writePackageEntries(path, map[string][]byte{"manifest.json": manifestJSON}); err != nil {
		t.Fatal(err)
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	err = SignPackage(path, filepath.Join(dir, "v1.signed.apg"), "test", privateKey)
	if err == nil || !strings.Contains(err.Error(), "manifestVersion 1 packages cannot be signed; upgrade to manifestVersion 2") {
		t.Fatalf("sign v1 error = %v", err)
	}
	pkg, err := ReadPackageBundle(path)
	if err != nil {
		t.Fatal(err)
	}
	err = VerifyTrust(pkg, TrustStore{Version: 1, Keys: map[string]string{}}, TrustRequireSigned)
	if err == nil || !strings.Contains(err.Error(), "manifestVersion 1 packages cannot be signed; upgrade to manifestVersion 2") {
		t.Fatalf("trust v1 error = %v", err)
	}
}

// rewritePackageEntry rebuilds a package with one entry mutated. The signature
// entry is preserved, so the rebuilt package keeps the original signer claim.
func rewritePackageEntry(t *testing.T, source, dest, name string, mutate func([]byte) []byte) {
	t.Helper()
	zr, err := zip.OpenReader(source)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	found := false
	for _, entry := range zr.File {
		data, err := func() ([]byte, error) {
			rc, err := entry.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(rc)
		}()
		if err != nil {
			t.Fatal(err)
		}
		if entry.Name == name {
			data = mutate(data)
			found = true
		}
		w, err := zw.Create(entry.Name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if !found {
		t.Fatalf("entry %q not found", name)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dest, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyTrustRequiresExplicitPolicy(t *testing.T) {
	dir := t.TempDir()
	manifest := Manifest{
		ManifestVersion: ManifestVersion2,
		ID:              "acme.nopolicy",
		Name:            "No Policy",
		Version:         "1.0.0",
		Scope:           "user",
		APIVersion:      APIVersion,
		Contributes:     Contributes{},
	}
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "nopolicy.apg")
	if err := writePackageEntries(path, map[string][]byte{"manifest.json": manifestJSON}); err != nil {
		t.Fatal(err)
	}
	pkg, err := ReadPackageBundle(path)
	if err != nil {
		t.Fatal(err)
	}
	// An empty policy must not degrade into "accept unsigned".
	err = VerifyTrust(pkg, TrustStore{Version: 1, Keys: map[string]string{}}, "")
	if err == nil || !strings.Contains(err.Error(), "trust policy is required") {
		t.Fatalf("empty policy: %v", err)
	}
	err = VerifyTrust(pkg, TrustStore{Version: 1, Keys: map[string]string{}}, TrustPolicy("sometimes"))
	if err == nil || !strings.Contains(err.Error(), "unsupported trust policy") {
		t.Fatalf("unknown policy: %v", err)
	}
	if err := VerifyTrust(pkg, TrustStore{Version: 1, Keys: map[string]string{}}, TrustAllowUnsigned); err != nil {
		t.Fatalf("unsigned package must load under allow-unsigned: %v", err)
	}
}

func FuzzReadPackageBundle(f *testing.F) {
	f.Add([]byte("PK\x03\x04"))
	f.Add([]byte("not a zip"))
	f.Fuzz(func(t *testing.T, data []byte) {
		path := filepath.Join(t.TempDir(), "fuzz.apg")
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Skip()
		}
		// The contract: arbitrary bytes must be rejected without panicking.
		_, _ = ReadPackageBundle(path)
	})
}
