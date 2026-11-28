package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"collaborative-whiteboard/apps/backend/internal/apg"
)

func TestAPGOfficialPackageLifecycle(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APG_DIR", dir)
	t.Setenv("APG_TRUST_STORE", filepath.Join(dir, "trust.json"))
	t.Setenv("APG_TRUST_POLICY", "require-signed")
	invoke := func(args ...string) string {
		t.Helper()
		var out bytes.Buffer
		if err := run(args, &out); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		return out.String()
	}
	reject := func(args ...string) {
		t.Helper()
		if err := run(args, &bytes.Buffer{}); err == nil {
			t.Fatalf("expected rejection: %v", args)
		}
	}
	key := filepath.Join(dir, "private.key")
	pub := invoke("keygen", key)
	trust := apg.TrustStore{Version: 1, Keys: map[string]string{"test": pub[:len(pub)-1]}}
	raw, _ := json.Marshal(trust)
	if err := os.WriteFile(filepath.Join(dir, "trust.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join("..", "..", "..", "..", "plugins", "official")
	artifacts := filepath.Join(dir, "packages")
	ids := []string{"brushes", "note-template", "palette", "scene-export", "scene-inspector", "shape-template", "shared-counter"}
	for _, name := range ids {
		unsigned := filepath.Join(artifacts, name+".apg")
		signed := filepath.Join(artifacts, name+".signed.apg")
		invoke("pack", filepath.Join(root, name, "manifest.json"), unsigned)
		reject("install", unsigned)
		invoke("sign", unsigned, signed, "test", key)
		invoke("verify", signed)
		invoke("install", signed)
		invoke("enable", "aevia."+name)
	}
	catalog, err := apg.LoadCatalogWithTrust(dir, trust, apg.TrustRequireSigned)
	if err != nil || len(catalog.Plugins) != len(ids) {
		t.Fatalf("catalog: %+v %v", catalog, err)
	}
	listLines := strings.Split(strings.TrimSpace(invoke("list")), "\n")
	wantLines := make([]string, 0, len(catalog.Plugins))
	for _, p := range catalog.Plugins {
		wantLines = append(wantLines, p.Manifest.ID+"\t"+p.Manifest.Version+"\t"+string(p.Manifest.Scope)+"\tenabled")
	}
	sort.Strings(wantLines)
	if strings.Join(listLines, "\n") != strings.Join(wantLines, "\n") {
		t.Fatalf("list output got %q want %q", listLines, wantLines)
	}
	previous := catalog.Revision
	var shape apg.CatalogPlugin
	for _, p := range catalog.Plugins {
		if p.Manifest.ID == "aevia.shape-template" {
			shape = p
		}
	}
	asset, err := apg.ReadArchivedAsset(dir, shape.Digest, "assets/card.json")
	if err != nil || !json.Valid(asset) {
		t.Fatalf("archive: %v", err)
	}
	// Update real source in a separate fixture; original official source is untouched.
	source := filepath.Join(dir, "update")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	updated := shape.Manifest
	updated.Version = "1.1.0"
	updated.Contributes.Commands[0].Resource = ""
	updated.Permissions = append(updated.Permissions, "storage.shared")
	data, _ := json.Marshal(updated)
	if err := os.WriteFile(filepath.Join(source, "manifest.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "main.js"), []byte(shape.Program), 0600); err != nil {
		t.Fatal(err)
	}
	unsigned, signed := filepath.Join(artifacts, "update.apg"), filepath.Join(artifacts, "update.signed.apg")
	invoke("pack", filepath.Join(source, "manifest.json"), unsigned)
	invoke("sign", unsigned, signed, "test", key)
	reject("update", signed)
	invoke("disable", "aevia.shape-template")
	if !strings.Contains(invoke("list"), "aevia.shape-template	"+shape.Manifest.Version+"	system	disabled") {
		t.Fatal("list did not report the disabled package state")
	}
	invoke("enable", "aevia.shape-template")
	invoke("disable", "aevia.shape-template")
	invoke("update", signed)
	invoke("enable", "aevia.shape-template")
	catalog, err = apg.LoadCatalogWithTrust(dir, trust, apg.TrustRequireSigned)
	if err != nil || catalog.Revision == previous {
		t.Fatalf("update revision: %v", err)
	}
	reject("rollback", "aevia.shape-template")
	invoke("disable", "aevia.shape-template")
	invoke("rollback", "aevia.shape-template")
	invoke("enable", "aevia.shape-template")
	catalog, err = apg.LoadCatalogWithTrust(dir, trust, apg.TrustRequireSigned)
	if err != nil || catalog.Revision != previous {
		t.Fatalf("rollback revision: %s want %s: %v", catalog.Revision, previous, err)
	}
	for _, name := range ids {
		invoke("disable", "aevia."+name)
		invoke("uninstall", "aevia."+name)
	}
	catalog, err = apg.LoadCatalogWithTrust(dir, trust, apg.TrustRequireSigned)
	if err != nil || len(catalog.Plugins) != 0 {
		t.Fatalf("uninstall: %v", err)
	}
	if _, err := apg.ReadArchivedAsset(dir, shape.Digest, "assets/card.json"); err != nil {
		t.Fatal(err)
	}
}

func TestAPGFailedInstallLeavesNoResidue(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APG_DIR", dir)
	t.Setenv("APG_TRUST_STORE", filepath.Join(dir, "trust.json"))
	t.Setenv("APG_TRUST_POLICY", "require-signed")
	// Not a ZIP at all: the install must fail before anything is staged.
	bad := filepath.Join(t.TempDir(), "bad.apg")
	if err := os.WriteFile(bad, []byte("not-a-package"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"install", bad}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected install rejection")
	}
	var out bytes.Buffer
	if err := run([]string{"list"}, &out); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != "" {
		t.Fatalf("failed install left an installed package: %q", out.String())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(strings.ToLower(entry.Name()), ".apg") {
			t.Fatalf("failed install left %q behind", entry.Name())
		}
	}
}

func TestAPGCLIDefaultsToRequireSigned(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APG_DIR", dir)
	t.Setenv("APG_TRUST_STORE", filepath.Join(dir, "trust.json"))
	t.Setenv("APG_TRUST_POLICY", "")
	invoke := func(args ...string) string {
		t.Helper()
		var out bytes.Buffer
		if err := run(args, &out); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		return out.String()
	}
	key := filepath.Join(dir, "private.key")
	invoke("keygen", key)

	writeManifest := func(name string, manifest apg.Manifest) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "manifest.json"), data, 0o600); err != nil {
			t.Fatal(err)
		}
		return filepath.Join(path, "manifest.json")
	}

	v2 := apg.Manifest{
		ManifestVersion: apg.ManifestVersion2,
		ID:              "acme.unsigned",
		Name:            "Unsigned",
		Version:         "1.0.0",
		Scope:           "user",
		APIVersion:      apg.APIVersion,
		Contributes: apg.Contributes{
			Palettes: []apg.Palette{{ID: "brand", Label: "Brand", Colors: []string{"#AABBCC"}}},
		},
	}
	unsigned := filepath.Join(dir, "packages", "unsigned.apg")
	invoke("pack", writeManifest("v2", v2), unsigned)
	if err := run([]string{"install", unsigned}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "package signature is required") {
		t.Fatalf("unsigned install error = %v", err)
	}

	v1 := apg.Manifest{
		ManifestVersion: apg.ManifestVersion,
		ID:              "acme.legacy",
		Name:            "Legacy",
		Version:         "1.0.0",
		Scope:           "user",
		Contributes:     apg.Contributes{},
	}
	legacy := filepath.Join(dir, "packages", "legacy.apg")
	invoke("pack", writeManifest("v1", v1), legacy)
	const v1Message = "manifestVersion 1 packages cannot be signed; upgrade to manifestVersion 2"
	if err := run([]string{"verify", legacy}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), v1Message) {
		t.Fatalf("v1 verify error = %v", err)
	}
	if err := run([]string{"sign", legacy, filepath.Join(dir, "packages", "legacy.signed.apg"), "test", key}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), v1Message) {
		t.Fatalf("v1 sign error = %v", err)
	}
}

func TestAPGUpdateRequiresReauthorization(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APG_DIR", dir)
	t.Setenv("APG_TRUST_STORE", filepath.Join(dir, "trust.json"))
	t.Setenv("APG_TRUST_POLICY", "require-signed")
	invoke := func(args ...string) string {
		t.Helper()
		var out bytes.Buffer
		if err := run(args, &out); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		return out.String()
	}
	runErr := func(args ...string) error {
		t.Helper()
		return run(args, &bytes.Buffer{})
	}
	firstKey := filepath.Join(dir, "first.key")
	nextKey := filepath.Join(dir, "next.key")
	firstPub := invoke("keygen", firstKey)
	nextPub := invoke("keygen", nextKey)
	trust := apg.TrustStore{Version: 1, Keys: map[string]string{
		"test": strings.TrimSpace(firstPub),
		"next": strings.TrimSpace(nextPub),
	}}
	rawTrust, err := json.Marshal(trust)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "trust.json"), rawTrust, 0o600); err != nil {
		t.Fatal(err)
	}

	manifest := func(name, version, color string) string {
		t.Helper()
		root := filepath.Join(dir, name)
		if err := os.MkdirAll(root, 0o700); err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(apg.Manifest{
			ManifestVersion: apg.ManifestVersion2,
			ID:              "acme.palette",
			Name:            "Palette",
			Version:         version,
			Scope:           "user",
			APIVersion:      apg.APIVersion,
			Contributes: apg.Contributes{
				Palettes: []apg.Palette{{ID: "brand", Label: "Brand", Colors: []string{color}}},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "manifest.json"), data, 0o600); err != nil {
			t.Fatal(err)
		}
		return filepath.Join(root, "manifest.json")
	}
	packSign := func(name, version, color, keyID, keyFile string) string {
		t.Helper()
		unsigned := filepath.Join(dir, "packages", name+".apg")
		signed := filepath.Join(dir, "packages", name+".signed.apg")
		invoke("pack", manifest(name, version, color), unsigned)
		invoke("sign", unsigned, signed, keyID, keyFile)
		return signed
	}

	first := packSign("first", "1.0.0", "#AABBCC", "test", firstKey)
	invoke("install", first)
	invoke("enable", "acme.palette")

	changed := packSign("changed", "1.1.0", "#112233", "test", firstKey)
	if err := runErr("update", changed); err == nil || !strings.Contains(err.Error(), `palette changed: "brand"`) {
		t.Fatalf("contribution update error = %v", err)
	}
	invoke("disable", "acme.palette")
	invoke("update", changed)
	invoke("enable", "acme.palette")

	resigned := packSign("resigned", "1.2.0", "#112233", "next", nextKey)
	if err := runErr("update", resigned); err == nil || !strings.Contains(err.Error(), `signing key changed from "test" to "next"`) {
		t.Fatalf("signer update error = %v", err)
	}
	invoke("disable", "acme.palette")
	invoke("update", resigned)
	invoke("enable", "acme.palette")

	identical := packSign("identical", "1.3.0", "#112233", "next", nextKey)
	if err := runErr("update", identical); err != nil {
		t.Fatalf("version-only update rejected: %v", err)
	}
}

func TestAPGLockRecordsOwnerAndRejectsConcurrentWriter(t *testing.T) {
	dir := t.TempDir()
	release, err := acquireLock(dir, "install")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, lockName, lockOwnerName))
	if err != nil {
		t.Fatalf("owner file: %v", err)
	}
	var owner lockOwner
	if err := json.Unmarshal(raw, &owner); err != nil {
		t.Fatalf("owner json: %v", err)
	}
	if owner.PID != os.Getpid() || owner.Command != "install" || owner.StartedAt == "" {
		t.Fatalf("unexpected owner: %+v", owner)
	}
	if _, err := acquireLock(dir, "enable"); err == nil || !strings.Contains(err.Error(), "APG lock is held") {
		t.Fatalf("expected lock conflict, got %v", err)
	}
	release()
	if _, err := os.Stat(filepath.Join(dir, lockName)); !os.IsNotExist(err) {
		t.Fatalf("lock directory was not removed: %v", err)
	}
	again, err := acquireLock(dir, "list")
	if err != nil {
		t.Fatalf("reacquire after release: %v", err)
	}
	again()
}

func TestAPGStaleLockWithoutOwnerIsReclaimed(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, lockName)
	if err := os.Mkdir(lock, 0700); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(lock, old, old); err != nil {
		t.Fatal(err)
	}
	release, err := acquireLock(dir, "install")
	if err != nil {
		t.Fatalf("expected stale lock to be reclaimed: %v", err)
	}
	release()
}

func TestAPGFreshLockWithoutOwnerIsNotStolen(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, lockName), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := acquireLock(dir, "install"); err == nil || !strings.Contains(err.Error(), "APG lock is held") {
		t.Fatalf("expected a fresh ownerless lock to be respected, got %v", err)
	}
}

func TestAPGDeadOwnerLockIsReclaimed(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, lockName)
	if err := os.Mkdir(lock, 0700); err != nil {
		t.Fatal(err)
	}
	// A PID far outside any real process table stands in for a crashed writer.
	raw, _ := json.Marshal(lockOwner{PID: 1 << 30, StartedAt: time.Now().UTC().Format(time.RFC3339), Command: "install"})
	if err := os.WriteFile(filepath.Join(lock, lockOwnerName), raw, 0600); err != nil {
		t.Fatal(err)
	}
	release, err := acquireLock(dir, "enable")
	if err != nil {
		t.Fatalf("expected a dead owner's lock to be reclaimed: %v", err)
	}
	release()
}

func TestAPGInitScaffoldsAPackablePackage(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "hello")
	var out bytes.Buffer
	if err := run([]string{"init", target, "acme.hello", "system"}, &out); err != nil {
		t.Fatalf("init: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(target, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := apg.ValidateManifestJSON(raw)
	if err != nil {
		t.Fatalf("scaffold manifest rejected by the real validator: %v", err)
	}
	if manifest.ID != "acme.hello" || manifest.Scope != "system" || manifest.APIVersion != 1 {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
	if _, err := os.Stat(filepath.Join(target, "main.js")); err != nil {
		t.Fatalf("main.js missing: %v", err)
	}
	packed := filepath.Join(root, "hello.apg")
	if err := run([]string{"pack", filepath.Join(target, "manifest.json"), packed}, &bytes.Buffer{}); err != nil {
		t.Fatalf("pack scaffold: %v", err)
	}
	if _, err := apg.ReadPackage(packed); err != nil {
		t.Fatalf("scaffold package unreadable: %v", err)
	}

	userTarget := filepath.Join(root, "viewer")
	if err := run([]string{"init", userTarget, "acme.viewer"}, &bytes.Buffer{}); err != nil {
		t.Fatalf("init default scope: %v", err)
	}
	userRaw, err := os.ReadFile(filepath.Join(userTarget, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	userManifest, err := apg.ValidateManifestJSON(userRaw)
	if err != nil {
		t.Fatalf("user scaffold rejected: %v", err)
	}
	if userManifest.Scope != "user" {
		t.Fatalf("default scope must be user, got %q", userManifest.Scope)
	}
}

func TestAPGInitRefusesToOverwriteOrMisuseTheScaffold(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "busy")
	if err := os.MkdirAll(target, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "keep.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"init", target, "acme.busy"}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected refusal to scaffold into a non-empty directory")
	}
	if _, err := os.Stat(filepath.Join(target, "manifest.json")); !os.IsNotExist(err) {
		t.Fatal("refused scaffold must not leave a manifest behind")
	}
	if err := run([]string{"init", filepath.Join(root, "bad"), "Acme.Bad"}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected invalid id rejection")
	}
	if err := run([]string{"init", filepath.Join(root, "badscope"), "acme.scope", "global"}, &bytes.Buffer{}); err == nil {
		t.Fatal("expected invalid scope rejection")
	}
}

func TestAPGStateCommandListsAndClearsRoomState(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "state.db")
	if err := os.WriteFile(dbPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := openStateStore(dbPath)
	if err != nil {
		t.Fatalf("open state store: %v", err)
	}
	ctx := context.Background()
	for _, room := range []string{"room-1", "room-2"} {
		if err := store.EnsureDefaultRoom(ctx, room); err != nil {
			t.Fatalf("ensure %s: %v", room, err)
		}
	}
	if _, err := store.WriteAPGState(ctx, "room-1", "aevia.shared-counter", 0, 1, json.RawMessage(`{"count":3}`)); err != nil {
		t.Fatalf("write room-1: %v", err)
	}
	if _, err := store.WriteAPGState(ctx, "room-2", "aevia.shared-counter", 0, 1, json.RawMessage(`{"count":9}`)); err != nil {
		t.Fatalf("write room-2: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	var out bytes.Buffer
	if err := run([]string{"state", "list", dbPath}, &out); err != nil {
		t.Fatalf("state list: %v", err)
	}
	if got := out.String(); !strings.Contains(got, "room-1	aevia.shared-counter	revision=1	schema=1") || !strings.Contains(got, "room-2") {
		t.Fatalf("state list = %q", got)
	}

	out.Reset()
	if err := run([]string{"state", "list", dbPath, "room-1"}, &out); err != nil {
		t.Fatalf("filtered list: %v", err)
	}
	if got := out.String(); strings.Contains(got, "room-2") || !strings.Contains(got, "room-1") {
		t.Fatalf("filtered list = %q", got)
	}

	if err := run([]string{"state", "clear", dbPath, "room-1"}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "--confirm") {
		t.Fatalf("clear without --confirm = %v", err)
	}
	if err := run([]string{"state", "clear", dbPath, "--confirm"}, &bytes.Buffer{}); err == nil {
		t.Fatal("clear without a room id succeeded")
	}

	out.Reset()
	if err := run([]string{"state", "clear", dbPath, "room-1", "--confirm"}, &out); err != nil {
		t.Fatalf("state clear: %v", err)
	}
	if got := strings.TrimSpace(out.String()); got != "deleted 1 shared-state row(s)" {
		t.Fatalf("state clear output = %q", got)
	}
	store, err = openStateStore(dbPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	state, err := store.ReadAPGState(ctx, "room-1", "aevia.shared-counter")
	if err != nil {
		t.Fatalf("read cleared: %v", err)
	}
	if state.Revision != 0 {
		t.Fatalf("cleared state revision = %d", state.Revision)
	}
	store.Close()

	missing := filepath.Join(dir, "missing.db")
	if err := run([]string{"state", "list", missing}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("missing database = %v", err)
	}
	if _, statErr := os.Stat(missing); statErr == nil {
		t.Fatal("inspecting a missing database created it")
	}
}
