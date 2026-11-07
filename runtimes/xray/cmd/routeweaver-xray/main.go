package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/privateipc"
	managed "routeweaver/runtimes/xray"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "managed Xray:", err)
		os.Exit(1)
	}
}
func run(args []string) (result error) {
	// Set the supported Go process default before the unchanged upstream runtime
	// can create listeners. Native sockopt overrides are rejected by managed config.
	// Preserve unrelated local Go tuning, but never an inherited MPTCP enable.
	debug := make([]string, 0)
	for _, setting := range strings.Split(os.Getenv("GODEBUG"), ",") {
		if setting != "" && !strings.HasPrefix(setting, "multipathtcp=") {
			debug = append(debug, setting)
		}
	}
	debug = append(debug, "multipathtcp=0")
	if err := os.Setenv("GODEBUG", strings.Join(debug, ",")); err != nil {
		return errors.New("cannot disable unsupported MPTCP")
	}

	if len(args) == 1 && args[0] == "version" {
		fmt.Println("RouteWeaver managed-xray", managed.Version, "Xray", managed.CoreVersion)
		return nil
	}
	if len(args) < 1 || (args[0] != "check" && args[0] != "run") {
		return errors.New("expected version, check or run")
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	config := fs.String("config", "", "native JSON path")
	policy := fs.String("policy", "", "policy sidecar path")
	admission := fs.String("admission-socket", "", "private agent socket")
	control := fs.String("control-socket", "", "private runtime socket")
	ipc := fs.String("ipc", "", "private IPC transport: pipes or unix")
	journalPath := fs.String("journal-dir", "", "private persistent counter journal")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() != 0 || *config == "" || *policy == "" {
		return errors.New("explicit config and policy paths required")
	}
	native, err := os.ReadFile(*config)
	if err != nil {
		return errors.New("native config unreadable")
	}
	p, err := os.Open(*policy)
	if err != nil {
		return errors.New("policy unreadable")
	}
	d, err := managed.DecodeDescriptor(p)
	p.Close()
	if err != nil {
		return err
	}
	if err = managed.Validate(native, d); err != nil {
		return errors.New("native config or managed policy rejected")
	}
	if args[0] == "check" {
		return nil
	}
	if *journalPath == "" {
		return errors.New("persistent journal path required")
	}
	var broker entrypolicy.Admission
	var brokerDone <-chan struct{}
	var controlDone <-chan struct{}
	var controlPipes *privateipc.Duplex
	if *ipc == "pipes" {
		reader, writer := os.NewFile(3, "admission-response"), os.NewFile(4, "admission-request")
		if reader == nil || writer == nil {
			return errors.New("missing inherited admission descriptors")
		}
		client := privateipc.NewAdmissionClient(privateipc.NewDuplex(reader, writer))
		defer client.Close()
		broker = client
		brokerDone = client.Done()
		controlReader, controlWriter := os.NewFile(5, "control-request"), os.NewFile(6, "control-response")
		if controlReader == nil || controlWriter == nil {
			return errors.New("missing inherited control descriptors")
		}
		controlPipes = privateipc.NewDuplex(controlReader, controlWriter)
		controlDone = controlPipes.Done()
		defer controlPipes.Close()
	} else if *ipc == "unix" {
		if *admission == "" || *control == "" {
			return errors.New("explicit private Unix socket paths required")
		}
		client, err := managed.NewSocketAdmission(*admission)
		if err != nil {
			return err
		}
		defer client.Close()
		broker = client
	} else {
		return errors.New("explicit private IPC transport required")
	}
	r, err := managed.New(native, d, broker)
	if err != nil {
		return errors.New("runtime construction failed")
	}
	defer r.Close()
	journal, err := managed.BeginJournal(*journalPath, r.Snapshot())
	if err != nil {
		return err
	}
	var closeControl func() error
	// From this point every exit owns an epoch, including control setup and
	// partial native startup failures. Close must drain successfully before the
	// real final snapshot can authorize another epoch. Preserve both the original
	// error and any cleanup failure; an uncertain epoch stays fail-closed.
	defer func() {
		if closeControl != nil {
			defer closeControl()
		}
		result = finishRuntime(r, journal, result)
	}()
	if controlPipes != nil {
		go privateipc.ServeControl(controlPipes, r)
	} else {
		closeControl, err = r.ServeControl(*control)
		if err != nil {
			return err
		}
	}
	if err = r.Start(); err != nil {
		return fmt.Errorf("runtime start failed: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	select {
	case <-ctx.Done():
	case <-brokerDone:
	case <-controlDone:
	}
	return nil
}

// Only a successful runtime drain authorizes taking final counter evidence.
// The narrow lifecycle contract also permits testing a close failure without
// presenting a synthetic snapshot as native accounting evidence.
type drainingRuntime interface {
	Close() error
	Snapshot() entrypolicy.Snapshot
}

func finishRuntime(r drainingRuntime, journal *managed.Journal, cause error) error {
	if err := r.Close(); err != nil {
		return errors.Join(cause, fmt.Errorf("runtime close failed; epoch requires reconciliation: %w", err))
	}
	if err := journal.Finish(r.Snapshot()); err != nil {
		return errors.Join(cause, fmt.Errorf("runtime finalization failed; epoch requires reconciliation: %w", err))
	}
	return cause
}
