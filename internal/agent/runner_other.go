//go:build !linux && !darwin && !freebsd

package agent

import "os/exec"

func configureCommand(cmd *exec.Cmd) {}
