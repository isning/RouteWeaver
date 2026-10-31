// notification-migrate creates a separately verified database; it never activates
// it or modifies the source's application data. Stop the control plane first.
package main

import (
	"context"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"routeweaver/internal/store"
	"runtime/debug"
	"syscall"
	"time"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(ctx context.Context, args []string, out io.Writer) error {
	flags := flag.NewFlagSet("notification-migrate", flag.ContinueOnError)
	flags.SetOutput(out)
	source := flags.String("source", "", "existing offline SQLite database (never changed)")
	output := flags.String("output", "", "new output database path; must not exist")
	record := flags.Int64("max-record-bytes", 0, "required reviewed legacy plaintext record limit, at most 268435456")
	memory := flags.Int64("memory-budget-bytes", 0, "required Go soft memory limit, at least 8*max-record-bytes+268435456")
	timeout := flags.Duration("timeout", 15*time.Minute, "operation timeout, greater than zero and at most 1h")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *source == "" || *output == "" {
		return errors.New("--source and --output are required; positional arguments are not accepted")
	}
	if *record < 1 || *record > store.MaxOfflineLegacyNotificationBytes {
		return errors.New("--max-record-bytes is required and must be 1–268435456")
	}
	required := 8**record + 256<<20
	if *memory < required {
		return fmt.Errorf("--memory-budget-bytes must be explicitly set to at least %d (a Go soft limit, not an OS memory guarantee)", required)
	}
	if *timeout <= 0 || *timeout > time.Hour {
		return errors.New("--timeout must be greater than zero and at most 1h")
	}
	key, err := hex.DecodeString(os.Getenv("ROUTEWEAVER_MASTER_KEY"))
	if err != nil || len(key) != 32 {
		return errors.New("ROUTEWEAVER_MASTER_KEY must be 64 hexadecimal characters (32 bytes), supplied by the operator")
	}
	previous := debug.SetMemoryLimit(*memory)
	defer debug.SetMemoryLimit(previous)
	deadline, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	if err = store.MigrateNotificationsFresh(deadline, *source, *output, key, *record); err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, "Migration completed: a verified new database was created. No service was activated; keep the original source unchanged.")
	return err
}
