package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"collaborative-whiteboard/apps/backend/internal/apg"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "apg:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	dir := os.Getenv("APG_DIR")
	if dir == "" {
		dir = filepath.Join("..", "..", "data", "apg")
	}
	if len(args) >= 2 && args[0] == "--dir" {
		dir, args = args[1], args[2:]
	}
	if len(args) == 0 || args[0] == "--help" || args[0] == "help" {
		fmt.Fprintln(out, "apg [--dir PATH] init <plugin-dir> <plugin-id> [user|system] | pack <manifest.json> <output.apg> | validate <file.apg> | verify <file.apg> | keygen <private-key-file> | sign <input.apg> <output.apg> <key-id> <private-key-file> | install <file.apg> | update <file.apg> | rollback <id> | list | enable <id> | disable <id> | uninstall <id> | state list <database-path> [room-id] [plugin-id] | state clear <database-path> <room-id> [plugin-id] --confirm")
		return nil
	}
	cmd := args[0]
	if cmd == "state" {
		return runState(args[1:], out)
	}
	if cmd == "init" {
		if len(args) < 3 || len(args) > 4 {
			return errors.New("usage: apg init <plugin-dir> <plugin-id> [user|system]")
		}
		scope := "user"
		if len(args) == 4 {
			scope = args[3]
		}
		return initPlugin(args[1], args[2], scope)
	}
	if cmd == "pack" {
		if len(args) != 3 {
			return errors.New("usage: apg pack <manifest.json> <output.apg>")
		}
		return apg.PackPackage(args[1], args[2])
	}
	if cmd == "keygen" {
		if len(args) != 2 {
			return errors.New("usage: apg keygen <private-key-file>")
		}
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		f, err := os.OpenFile(args[1], os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, err = f.WriteString(base64.StdEncoding.EncodeToString(priv))
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		fmt.Fprintln(out, base64.StdEncoding.EncodeToString(pub))
		return nil
	}
	if cmd == "sign" {
		if len(args) != 5 {
			return errors.New("usage: apg sign <input.apg> <output.apg> <key-id> <private-key-file>")
		}
		raw, err := os.ReadFile(args[4])
		if err != nil {
			return err
		}
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil {
			return err
		}
		return apg.SignPackage(args[1], args[2], args[3], ed25519.PrivateKey(key))
	}
	if cmd == "validate" || cmd == "verify" {
		if len(args) != 2 {
			return errors.New("usage: apg validate <file.apg>")
		}
		pkg, err := apg.ReadPackageBundle(args[1])
		if err != nil {
			return err
		}
		if cmd == "verify" {
			if err := verifyPackage(dir, pkg); err != nil {
				return err
			}
		}
		m := pkg.Manifest
		fmt.Fprintf(out, "%s %s (%s) %s\n", m.ID, m.Version, m.Scope, pkg.Digest)
		return nil
	}
	if cmd != "list" && cmd != "install" && cmd != "update" && cmd != "rollback" && cmd != "enable" && cmd != "disable" && cmd != "uninstall" {
		return fmt.Errorf("unknown command %q", cmd)
	}
	if (cmd == "list" && len(args) != 1) || (cmd != "list" && len(args) != 2) {
		return errors.New("invalid argument count; run apg help")
	}
	if err := os.MkdirAll(filepath.Join(dir, "disabled"), 0700); err != nil {
		return err
	}
	// Serialize cooperating CLI writers; a crashed writer's lock is reclaimed once its owner is
	// gone (see lock.go) instead of blocking every later deployment command.
	releaseLock, err := acquireLock(dir, cmd)
	if err != nil {
		return err
	}
	defer releaseLock()
	enabled, err := scan(dir)
	if err != nil {
		return err
	}
	disabled, err := scan(filepath.Join(dir, "disabled"))
	if err != nil {
		return err
	}
	for id := range enabled {
		if _, ok := disabled[id]; ok {
			return fmt.Errorf("duplicate installed plugin %q", id)
		}
	}
	if cmd == "list" {
		for _, group := range []struct {
			items  map[string]installed
			status string
		}{{enabled, "enabled"}, {disabled, "disabled"}} {
			ids := make([]string, 0, len(group.items))
			for id := range group.items {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, id := range ids {
				v := group.items[id]
				fmt.Fprintf(out, "%s\t%s\t%s\t%s\n", v.manifest.ID, v.manifest.Version, v.manifest.Scope, group.status)
			}
		}
		return nil
	}
	if cmd == "install" || cmd == "update" {
		pkg, err := apg.ReadPackageBundle(args[1])
		if err != nil {
			return err
		}
		if err := verifyPackage(dir, pkg); err != nil {
			return err
		}
		m := pkg.Manifest
		old, on := enabled[m.ID]
		off, existsOff := disabled[m.ID]
		if existsOff {
			old = off
		}
		exists := on || existsOff
		if cmd == "install" && exists {
			return errors.New("already installed; use update")
		}
		if cmd == "update" && !exists {
			return errors.New("not installed; use install")
		}
		if exists && old.manifest.Scope != m.Scope {
			return errors.New("scope change requires explicit uninstall and install")
		}
		if exists {
			if old.manifest.Version == m.Version {
				return errors.New("update requires a different version")
			}
			// Expanded capabilities must be explicitly re-authorized by
			// disabling the plugin before the replacement is installed.
			if on {
				if changes := apg.ReauthorizationChanges(old.pkg, pkg); len(changes) > 0 {
					return fmt.Errorf("disable plugin before updating; re-authorization required: %s", strings.Join(changes, "; "))
				}
			}
			if err := saveRollback(dir, old); err != nil {
				return err
			}
		}
		// Newly installed packages are disabled until the deployer explicitly enables them.
		dest := filepath.Join(dir, "disabled", m.ID+".apg")
		if exists {
			dest = old.path
		}
		if err := archivePackage(dir, args[1], pkg); err != nil {
			return err
		}
		return copyPackage(args[1], dest, exists, func(staged apg.Package) error {
			if staged.Digest != pkg.Digest {
				return errors.New("source package changed during install")
			}
			return verifyPackage(dir, staged)
		})
	}
	id := args[1]
	old, on := enabled[id]
	off, existsOff := disabled[id]
	if existsOff {
		old = off
	}
	if !on && !existsOff {
		return errors.New("plugin not installed")
	}
	switch cmd {
	case "rollback":
		backup := filepath.Join(dir, "rollback", id+".apg")
		pkg, err := apg.ReadPackageBundle(backup)
		if err != nil {
			return err
		}
		if pkg.Manifest.ID != id || pkg.Manifest.Scope != old.manifest.Scope {
			return errors.New("rollback identity mismatch")
		}
		if on {
			return errors.New("disable plugin before rollback")
		}
		return copyPackage(backup, old.path, true, func(p apg.Package) error { return verifyPackage(dir, p) })
	case "enable":
		if on {
			return nil
		}
		if len(enabled) >= apg.MaxCatalogPlugins {
			return errors.New("enabled catalog limit reached")
		}
		pkg, err := apg.ReadPackageBundle(old.path)
		if err != nil {
			return err
		}
		if err := verifyPackage(dir, pkg); err != nil {
			return err
		}
		return move(old.path, filepath.Join(dir, id+".apg"))
	case "disable":
		if !on {
			return nil
		}
		return move(old.path, filepath.Join(dir, "disabled", id+".apg"))
	case "uninstall":
		return os.Remove(old.path)
	}
	return nil
}

func verifyPackage(dir string, pkg apg.Package) error {
	trustPath := os.Getenv("APG_TRUST_STORE")
	if trustPath == "" {
		trustPath = filepath.Join(dir, "trust.json")
	}
	store, err := apg.LoadTrustStore(trustPath)
	if err != nil {
		return err
	}
	policy := apg.TrustPolicy(os.Getenv("APG_TRUST_POLICY"))
	if policy == "" {
		policy = apg.TrustRequireSigned
	}
	return apg.VerifyTrust(pkg, store, policy)
}

func archivePackage(dir, source string, pkg apg.Package) error {
	if len(pkg.Assets) == 0 {
		return nil
	}
	dest := filepath.Join(dir, "archive", pkg.Digest+".apg")
	if existing, err := apg.ReadPackageBundle(dest); err == nil {
		if existing.Digest != pkg.Digest {
			return errors.New("archive digest mismatch")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return copyPackage(source, dest, false, func(staged apg.Package) error {
		if staged.Digest != pkg.Digest {
			return errors.New("archive digest mismatch")
		}
		return verifyPackage(dir, staged)
	})
}

func saveRollback(dir string, old installed) error {
	return copyPackage(old.path, filepath.Join(dir, "rollback", old.manifest.ID+".apg"), true, func(p apg.Package) error {
		if p.Manifest.ID != old.manifest.ID || p.Manifest.Version != old.manifest.Version {
			return errors.New("rollback source changed")
		}
		return nil
	})
}

func copyPackage(src, dest string, replace bool, verify func(apg.Package) error) error {
	return stage(filepath.Dir(dest), dest, replace, func(f *os.File) error {
		source, err := os.Open(src)
		if err != nil {
			return err
		}
		defer source.Close()
		_, err = io.Copy(f, io.LimitReader(source, apg.MaxPackageBytes+1))
		return err
	}, verify)
}

type installed struct {
	manifest apg.Manifest
	pkg      apg.Package
	path     string
}

func scan(dir string) (map[string]installed, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	result := map[string]installed{}
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".apg") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		pkg, err := apg.ReadPackageBundle(p)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		if _, ok := result[pkg.Manifest.ID]; ok {
			return nil, fmt.Errorf("duplicate plugin id %q", pkg.Manifest.ID)
		}
		result[pkg.Manifest.ID] = installed{manifest: pkg.Manifest, pkg: pkg, path: p}
	}
	return result, nil
}

func move(src, dest string) error {
	if _, err := os.Lstat(dest); err == nil {
		return errors.New("destination exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(src, dest)
}

func stage(dir, dest string, replace bool, write func(*os.File) error, verify func(apg.Package) error) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// Temp directory is ignored by catalog discovery, including while validation runs.
	temp, err := os.MkdirTemp(dir, ".apg-stage-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)
	p := filepath.Join(temp, "package.apg")
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = write(f)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	pkg, err := apg.ReadPackageBundle(p)
	if err != nil {
		return err
	}
	if verify != nil {
		if err := verify(pkg); err != nil {
			return err
		}
	}
	if !replace {
		return move(p, dest)
	}
	return os.Rename(p, dest)
}
