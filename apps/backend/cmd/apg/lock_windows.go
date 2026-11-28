//go:build windows

package main

import "os"

// FindProcess opens the process handle; it fails when the PID is gone, which is all this check
// needs. A recycled PID can make a dead writer look alive, so a false "alive" only delays
// reclaim by one inspection instead of risking a concurrent writer.
func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	_ = process.Release()
	return true
}
