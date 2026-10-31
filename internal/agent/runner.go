package agent

import (
	"context"
	"errors"
	"os/exec"
	"sync"
	"time"
)

type cappedOutput struct {
	mu       sync.Mutex
	data     []byte
	limit    int
	overflow bool
}

func (b *cappedOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	remaining := b.limit - len(b.data)
	if len(p) > remaining {
		p = p[:remaining]
		b.overflow = true
	}
	b.data = append(b.data, p...)
	return n, nil
}

// runBounded does not invoke a shell or inherit ambient credentials/config. The
// OS helper terminates the direct child through its stable handle; WaitDelay
// also bounds pipe shutdown. A truncated output is a failed check, not success.
func runBounded(ctx context.Context, binary string, args []string, dir string, timeout time.Duration, limit int, environment ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = dir
	cmd.Env = append([]string{"PATH=/usr/bin:/bin", "HOME=" + dir, "LANG=C", "LC_ALL=C"}, environment...)
	cmd.Stdin = nil
	cmd.WaitDelay = 250 * time.Millisecond
	configureCommand(cmd)
	output := &cappedOutput{limit: limit}
	cmd.Stdout = output
	cmd.Stderr = output
	err := cmd.Run()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil {
		return "", errors.New("bounded command failed")
	}
	if output.overflow {
		return "", errors.New("bounded command output exceeded limit")
	}
	return string(output.data), nil
}
