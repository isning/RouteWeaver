//go:build linux

package agent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Return the actual payload connection, without sending probe traffic or
// retrying any authenticated exchange. Pin the full owned process record so
// even a replacement with the same desired identity cannot satisfy readiness.
func dialManagedEOFListener(ctx context.Context, address string, supervisor *ProcessSupervisor, root string, expected Identity) (net.Conn, error) {
	var owned processRecord
	if err := readJSON(processFile(root), &owned); err != nil {
		return nil, fmt.Errorf("EOF listener ownership: %w", err)
	}
	if owned.Identity != expected {
		return nil, errors.New("EOF listener owned identity differs from activation")
	}
	checkOwned := func() error {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("EOF listener connection budget exhausted: %w", err)
		}
		var current processRecord
		if err := readJSON(processFile(root), &current); err != nil {
			return fmt.Errorf("EOF listener ownership: %w", err)
		}
		if current != owned {
			return errors.New("EOF listener owned process record changed")
		}
		alive, err := supervisor.matches(owned)
		if err != nil {
			return fmt.Errorf("EOF listener owned process invalid: %w", err)
		}
		if !alive {
			return errors.New("EOF listener owned process disappeared")
		}
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("EOF listener connection budget exhausted: %w", err)
		}
		return nil
	}
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if err := checkOwned(); err != nil {
			return nil, err
		}
		conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
		if err == nil {
			if err := checkOwned(); err != nil {
				conn.Close()
				return nil, err
			}
			return conn, nil
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("EOF listener connection budget exhausted: %w", ctx.Err())
		}
		if !errors.Is(err, syscall.ECONNREFUSED) {
			return nil, fmt.Errorf("EOF listener connect: %w", err)
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("EOF listener connection budget exhausted after refusal: %w", ctx.Err())
		case <-tick.C:
		}
	}
}

func TestManagedEOFListenerConnectionBudgetAndOwnership(t *testing.T) {
	t.Run("ready connection", func(t *testing.T) {
		_, supervisor, root, _ := supervisorExitFixture(t, true, nil)
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		conn, err := dialManagedEOFListener(ctx, listener.Addr().String(), supervisor, root, Identity{})
		if err != nil {
			t.Fatal(err)
		}
		conn.Close()
	})
	t.Run("refusal exhausts budget", func(t *testing.T) {
		_, supervisor, root, _ := supervisorExitFixture(t, true, nil)
		address := fmt.Sprintf("127.0.0.1:%d", freeLoopbackPort(t))
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		conn, err := dialManagedEOFListener(ctx, address, supervisor, root, Identity{})
		if conn != nil {
			conn.Close()
			t.Fatal("unexpected listener on released fixture port")
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("connection budget error: %v", err)
		}
	})
	t.Run("reaped owned process", func(t *testing.T) {
		cmd, supervisor, root, done := supervisorExitFixture(t, true, nil)
		if err := cmd.Process.Kill(); err != nil {
			t.Fatal(err)
		}
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("owned fixture was not reaped")
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		conn, err := dialManagedEOFListener(ctx, "127.0.0.1:0", supervisor, root, Identity{})
		if conn != nil || err == nil || !strings.Contains(err.Error(), "owned process disappeared") {
			t.Fatalf("process disappearance: conn=%v err=%v", conn, err)
		}
	})
}
