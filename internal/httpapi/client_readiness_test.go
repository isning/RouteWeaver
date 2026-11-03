package httpapi_test

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The pinned mihomo creates its listener before tunnel.OnRunning. Its official
// post-up hook runs after hub.Parse/ApplyConfig returns, so a listening socket
// alone is not readiness. The hook changes no downloaded configuration and
// sends no traffic that could contaminate the actual request assertions.
// https://github.com/MetaCubeX/mihomo/blob/v1.19.32/main.go#L201-L219
// https://github.com/MetaCubeX/mihomo/blob/v1.19.32/hub/executor/executor.go#L79-L116
func newClientReadyMarker(dir, adapter string) (marker, hook string, err error) {
	if adapter != "mihomo" {
		return "", "", nil
	}
	// Allocate a fresh directory for each process, even if its cwd is reused.
	// No pre-existing marker from an earlier process can satisfy this instance.
	owned, err := os.MkdirTemp(dir, "native-ready-")
	if err != nil {
		return "", "", err
	}
	marker = filepath.Join(owned, "ready")
	// Quote the entire path, including any quotes/spaces in the parent's cwd.
	quoted := "'" + strings.ReplaceAll(marker, "'", "'\"'\"'") + "'"
	return marker, "printf ready > " + quoted, nil
}

func waitClientReady(ctx context.Context, address, marker string, exited <-chan struct{}) error {
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-exited:
			return fmt.Errorf("native process exited before readiness")
		case <-ctx.Done():
			return fmt.Errorf("native startup timeout waiting for marker and listener: %w", ctx.Err())
		default:
		}
		ready := marker == ""
		if marker != "" {
			content, err := os.ReadFile(marker)
			if err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("read native startup marker: %w", err)
			}
			ready = err == nil && string(content) == "ready"
		}
		if ready {
			conn, err := (&net.Dialer{Timeout: 50 * time.Millisecond}).DialContext(ctx, "tcp", address)
			if err == nil {
				conn.Close()
				// Do not accept a marker from a child already known to have exited.
				select {
				case <-exited:
					return fmt.Errorf("native process exited before readiness")
				case <-ctx.Done():
					return fmt.Errorf("native startup deadline: %w", ctx.Err())
				default:
					return nil
				}
			}
		}
		select {
		case <-exited:
			return fmt.Errorf("native process exited before readiness")
		case <-ctx.Done():
			return fmt.Errorf("native startup timeout waiting for marker and listener: %w", ctx.Err())
		case <-tick.C:
		}
	}
}

func TestClientReadinessRequiresCurrentProcessMarker(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	dir := t.TempDir()
	old, _, err := newClientReadyMarker(dir, "mihomo")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(old, []byte("ready"), 0600); err != nil {
		t.Fatal(err)
	}
	marker, _, err := newClientReadyMarker(dir, "mihomo")
	if err != nil || marker == old {
		t.Fatalf("marker must be owned by this process: %q %v", marker, err)
	}
	exited := make(chan struct{})
	for _, content := range []string{"missing", "", "read", "ready\n"} {
		t.Run(content, func(t *testing.T) {
			if content != "missing" {
				if err := os.WriteFile(marker, []byte(content), 0600); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
			defer cancel()
			if err := waitClientReady(ctx, listener.Addr().String(), marker, exited); err == nil || !strings.Contains(err.Error(), "startup timeout") {
				t.Fatalf("listening socket and stale marker must not imply readiness: %v", err)
			}
		})
	}
	if err := os.WriteFile(marker, []byte("ready"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := waitClientReady(ctx, listener.Addr().String(), marker, exited); err != nil {
		t.Fatal(err)
	}
	close(exited)
	if err := waitClientReady(ctx, listener.Addr().String(), marker, exited); err == nil || !strings.Contains(err.Error(), "exited") {
		t.Fatalf("ready marker cannot revive an exited process: %v", err)
	}
}

func TestClientReadinessReportsEarlyExit(t *testing.T) {
	marker, _, err := newClientReadyMarker(t.TempDir(), "mihomo")
	if err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	close(exited)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for range 2 {
		if err := waitClientReady(ctx, "127.0.0.1:0", marker, exited); err == nil || !strings.Contains(err.Error(), "exited") {
			t.Fatalf("early exit must remain observable by readiness and cleanup: %v", err)
		}
	}
}

func TestClientReadinessRequiresListenerAfterMarker(t *testing.T) {
	marker, _, err := newClientReadyMarker(t.TempDir(), "mihomo")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte("ready"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	if err := waitClientReady(ctx, "127.0.0.1:0", marker, make(chan struct{})); err == nil || !strings.Contains(err.Error(), "startup timeout") {
		t.Fatalf("post-up alone must not imply a working listener: %v", err)
	}
}

func TestClientReadinessHookQuotesPrivatePath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the pinned Linux native harness uses mihomo's POSIX post-up shell")
	}
	dir := filepath.Join(t.TempDir(), "cwd with ' quotes; $(false)")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	marker, hook, err := newClientReadyMarker(dir, "mihomo")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("marker must not exist until post-up: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "sh", "-c", hook).CombinedOutput(); err != nil {
		t.Fatalf("post-up hook: %v %s", err, output)
	}
	if content, err := os.ReadFile(marker); err != nil || string(content) != "ready" {
		t.Fatalf("post-up did not write its exact private marker: %q %v", content, err)
	}
	if marker, hook, err := newClientReadyMarker(dir, "sing-box"); err != nil || marker != "" || hook != "" {
		t.Fatalf("mihomo-specific hook leaked to another core: %q %q %v", marker, hook, err)
	}
}
