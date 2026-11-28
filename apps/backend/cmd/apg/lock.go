package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// A lock directory is the only cross-process guard for a deployment directory. It holds an
// owner file so a crashed CLI can be told apart from a live one; without a usable owner file the
// lock is only considered stale after staleLockAfter, which keeps slow-but-alive writers safe.
const (
	lockName       = ".apg-lock"
	lockOwnerName  = "owner.json"
	staleLockAfter = 15 * time.Minute
)

type lockOwner struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt"`
	Command   string `json:"command"`
}

// acquireLock takes the deployment lock and returns its release function. Two processes cannot
// hold it at once; a second acquisition in the same process also fails until release runs.
func acquireLock(dir, command string) (func(), error) {
	lock := filepath.Join(dir, lockName)
	release := func() { _ = os.RemoveAll(lock) }
	if err := os.Mkdir(lock, 0700); err != nil {
		if !errors.Is(err, fs.ErrExist) {
			return nil, fmt.Errorf("acquire APG lock: %w", err)
		}
		if !staleLock(lock) {
			return nil, fmt.Errorf("APG lock is held by another process (%s); delete it only if no apg command is running", lock)
		}
		if err := os.RemoveAll(lock); err != nil {
			return nil, fmt.Errorf("reclaim stale APG lock: %w", err)
		}
		if err := os.Mkdir(lock, 0700); err != nil {
			return nil, fmt.Errorf("acquire APG lock after reclaim: %w", err)
		}
	}
	owner := lockOwner{PID: os.Getpid(), StartedAt: time.Now().UTC().Format(time.RFC3339), Command: command}
	if raw, err := json.Marshal(owner); err == nil {
		_ = os.WriteFile(filepath.Join(lock, lockOwnerName), raw, 0600)
	}
	return release, nil
}

func staleLock(lock string) bool {
	raw, err := os.ReadFile(filepath.Join(lock, lockOwnerName))
	if err != nil {
		// No owner file yet (a writer may be between mkdir and write), or an unreadable one:
		// only an old lock is reclaimed, so a slow live writer is never preempted.
		return lockOlderThan(lock, staleLockAfter)
	}
	var owner lockOwner
	if json.Unmarshal(raw, &owner) != nil || owner.PID <= 0 {
		return lockOlderThan(lock, staleLockAfter)
	}
	if owner.PID == os.Getpid() {
		return false
	}
	return !processAlive(owner.PID)
}

func lockOlderThan(path string, age time.Duration) bool {
	info, err := os.Stat(path)
	return err == nil && time.Since(info.ModTime()) > age
}
