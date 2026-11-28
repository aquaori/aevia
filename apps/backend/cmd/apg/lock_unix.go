//go:build !windows

package main

import (
	"os"
	"syscall"
)

func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	defer func() { _ = process.Release() }()
	return process.Signal(syscall.Signal(0)) == nil
}
