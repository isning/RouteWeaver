package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"routeweaver/internal/entrypolicy"
	managed "routeweaver/runtimes/xray"
)

// This is cleanup-contract fault injection, not native failure evidence. The
// journal baseline below comes from a real runtime; no fake snapshot exists.
type failedDrain struct{ err error }

func (r failedDrain) Close() error { return r.err }
func (r failedDrain) Snapshot() entrypolicy.Snapshot {
	panic("snapshot taken after failed drain")
}

type unavailableAdmission struct{}

func (unavailableAdmission) Acquire(context.Context, entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	return entrypolicy.Lease{}, errors.New("test admission unavailable")
}
func (unavailableAdmission) Release(context.Context, string) error { return nil }

func lifecycleFixture() ([]byte, entrypolicy.Descriptor) {
	native := []byte(`{"log":{"loglevel":"none"},"inbounds":[{"tag":"public","listen":"127.0.0.1","port":22001,"protocol":"vless","settings":{"decryption":"none","clients":[{"id":"00112233-4455-6677-8899-aabbccddeeff","email":"opaque-subject"}]},"streamSettings":{"network":"tcp","security":"none"}}],"outbounds":[{"tag":"direct","protocol":"freedom"}]}`)
	d := entrypolicy.Descriptor{SchemaVersion: 1, AdapterID: managed.AdapterID, RuntimeVersion: managed.Version, CoreVersion: managed.CoreVersion, Bindings: []entrypolicy.Binding{{SubjectID: "opaque-subject", AccountID: "account-1", RouteID: "route-1", EntryID: "entry-1", InboundTag: "public", CredentialVersion: "credential-1", PolicyRevision: "policy-1", CycleID: "cycle-1"}}}
	return native, d
}

func TestFailedDrainPreservesStartupErrorAndUnfinishedJournal(t *testing.T) {
	native, d := lifecycleFixture()
	r, err := managed.New(native, d, unavailableAdmission{})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	dir := filepath.Join(t.TempDir(), "journal")
	baseline := r.Snapshot()
	journal, err := managed.BeginJournal(dir, baseline)
	if err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(dir, "running.json")
	marker, err := os.ReadFile(markerPath)
	if err != nil {
		t.Fatal(err)
	}
	startupErr := errors.New("original startup failure")
	closeErr := errors.New("injected drain failure")
	result := finishRuntime(failedDrain{err: closeErr}, journal, startupErr)
	if !errors.Is(result, startupErr) || !errors.Is(result, closeErr) {
		t.Fatalf("lost startup or cleanup error: %v", result)
	}
	after, err := os.ReadFile(markerPath)
	if err != nil || !bytes.Equal(marker, after) {
		t.Fatal("unfinished marker changed", err)
	}
	finals, err := filepath.Glob(filepath.Join(dir, "*.final.json"))
	if err != nil || len(finals) != 0 {
		t.Fatalf("failed drain finalized journal: %v: %v", finals, err)
	}
	if _, err = managed.BeginJournal(dir, baseline); err == nil {
		t.Fatal("failed drain authorized new epoch")
	}
}

func TestFailedFinalWritePreservesStartupErrorAndJournalEvidence(t *testing.T) {
	native, d := lifecycleFixture()
	r, err := managed.New(native, d, unavailableAdmission{})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	dir := filepath.Join(t.TempDir(), "journal")
	baseline := r.Snapshot()
	journal, err := managed.BeginJournal(dir, baseline)
	if err != nil {
		t.Fatal(err)
	}
	markerPath := filepath.Join(dir, "running.json")
	marker, err := os.ReadFile(markerPath)
	if err != nil {
		t.Fatal(err)
	}
	finalPath := filepath.Join(dir, baseline.CounterEpoch+".final.json")
	partial := []byte("partial final evidence")
	if err = os.WriteFile(finalPath, partial, 0600); err != nil {
		t.Fatal(err)
	}
	startupErr := errors.New("original startup failure")
	result := finishRuntime(r, journal, startupErr)
	var writeErr *os.PathError
	if !errors.Is(result, startupErr) || !errors.As(result, &writeErr) || writeErr.Path != finalPath || !errors.Is(writeErr, os.ErrExist) {
		t.Fatalf("lost startup or final write error: %v", result)
	}
	after, err := os.ReadFile(markerPath)
	if err != nil || !bytes.Equal(marker, after) {
		t.Fatal("unfinished marker changed", err)
	}
	after, err = os.ReadFile(finalPath)
	if err != nil || !bytes.Equal(partial, after) {
		t.Fatal("partial final evidence changed", err)
	}
	if _, err = managed.BeginJournal(dir, baseline); err == nil {
		t.Fatal("failed final write authorized new epoch")
	}
}
