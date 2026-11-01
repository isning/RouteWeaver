package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

func TestBackupSetCommandRejectsUnknownBeforeStartup(t *testing.T) {
	for _, args := range [][]string{{"backup-set"}, {"backup-set", "unknown"}, {"unknown"}} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			oldArgs, oldFlags := os.Args, flag.CommandLine
			defer func() { os.Args, flag.CommandLine = oldArgs, oldFlags }()
			os.Args = append([]string{"control-plane"}, args...)
			flag.CommandLine = flag.NewFlagSet("control-plane", flag.ContinueOnError)
			err := run()
			if err == nil || !strings.Contains(err.Error(), "command") {
				t.Fatalf("expected command rejection before daemon setup, got %v", err)
			}
		})
	}
}

func TestBackupSetInvalidOptionsDoNotReadSecretsOrTouchSource(t *testing.T) {
	source := filepath.Join(t.TempDir(), "must-not-be-created.db")
	valid := []string{"create", "--db", source, "--set-dir", filepath.Join(t.TempDir(), "set"), "--total-bytes", "1048576", "--total-rows", "100", "--part-bytes", "65536", "--part-rows", "10", "--record-bytes", "8192", "--parts", "32", "--timeout", "1m", "--disk-bytes", "268435456"}
	cases := [][]string{
		{"create"},
		{"create", "--password", "synthetic-secret-not-for-logs"},
		append(append([]string{}, valid...), "--total-rows", "0"),
		append(append([]string{}, valid...), "--timeout", "7h"),
		append(append([]string{}, valid...), "--total-bytes", "34359738369"),
		append(append([]string{}, valid...), "--disk-bytes", "1"),
		append(append([]string{}, valid...), "unexpected"),
	}
	for _, args := range cases {
		var output strings.Builder
		err := runBackupSet(context.Background(), args, neverReadPassword{t}, &output, func(string) string { return strings.Repeat("ab", 32) })
		if err == nil {
			t.Fatalf("invalid command accepted: %v", args)
		}
		if strings.Contains(err.Error(), "synthetic-secret-not-for-logs") || output.Len() != 0 {
			t.Fatal("command exposed secret or success output")
		}
		if _, err := os.Stat(source); !os.IsNotExist(err) {
			t.Fatalf("invalid command touched source: %v", err)
		}
	}
	// Every budget must be supplied, not inherited from an implicit default.
	for _, name := range []string{"--total-bytes", "--total-rows", "--part-bytes", "--part-rows", "--record-bytes", "--parts", "--timeout", "--disk-bytes"} {
		args := append([]string{}, valid...)
		for i, v := range args {
			if v == name {
				args = append(args[:i], args[i+2:]...)
				break
			}
		}
		if err := runBackupSet(context.Background(), args, neverReadPassword{t}, io.Discard, func(string) string { return strings.Repeat("ab", 32) }); err == nil {
			t.Fatalf("missing %s accepted", name)
		}
	}
}

type neverReadPassword struct{ t *testing.T }

func (r neverReadPassword) Read([]byte) (int, error) {
	r.t.Fatal("invalid command consumed password")
	return 0, io.EOF
}

func TestBackupSetPasswordInput(t *testing.T) {
	for _, input := range []string{"", "short", "synthetic-password\nsecond-line", strings.Repeat("x", 1025)} {
		password, err := readBackupSetPassword(strings.NewReader(input))
		if err == nil || password != "" || (input != "" && strings.Contains(err.Error(), input)) {
			t.Fatal("invalid password accepted or reflected")
		}
	}
	for _, suffix := range []string{"", "\n", "\r\n"} {
		password, err := readBackupSetPassword(strings.NewReader("synthetic-backup-password" + suffix))
		if err != nil || password != "synthetic-backup-password" {
			t.Fatal("valid private input rejected", err)
		}
	}
}

func TestBackupSetCLICreatesAndRestoresOfflineWithoutActivation(t *testing.T) {
	dir := t.TempDir()
	source, target, setDir := filepath.Join(dir, "source.db"), filepath.Join(dir, "restored.db"), filepath.Join(dir, "complete-set")
	key := bytes.Repeat([]byte{33}, 32)
	sourceStore, err := store.Open(source, key)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		if err = sourceStore.Put("ledger", id, map[string]string{"evidence": id}); err != nil {
			t.Fatal(err)
		}
	}
	if err = sourceStore.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	budgets := []string{"--total-bytes", "2097152", "--total-rows", "100", "--part-bytes", "32768", "--part-rows", "2", "--record-bytes", "8192", "--parts", "32", "--timeout", "1m", "--disk-bytes", "268435456"}
	invoke := func(verb, db string) (string, error) {
		var output strings.Builder
		args := append([]string{verb, "--db", db, "--set-dir", setDir}, budgets...)
		err := runBackupSet(context.Background(), args, strings.NewReader("synthetic-set-cli-passphrase\n"), &output, func(string) string { return hex.EncodeToString(key) })
		return output.String(), err
	}
	if _, err = invoke("create", source); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("export changed source database", err)
	}
	parts, err := filepath.Glob(filepath.Join(setDir, "part-*.age"))
	if err != nil || len(parts) < 2 {
		t.Fatal("fixture did not cross part boundary", err)
	}
	if _, err = invoke("create", source); err == nil {
		t.Fatal("occupied output accepted")
	}
	output, err := invoke("restore", target)
	if err != nil || !strings.Contains(output, "not activated") {
		t.Fatal("restore outcome lost activation distinction", err)
	}
	restored, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		var v map[string]string
		if err = restored.Get("ledger", id, &v); err != nil || v["evidence"] != id {
			t.Fatal("lost evidence", id, err)
		}
	}
	if _, err = invoke("restore", target); err == nil {
		t.Fatal("occupied restore target accepted")
	}
}

func TestBackupSetInvalidKeyAndCancellationDoNotReadPassword(t *testing.T) {
	args := []string{"create", "--db", filepath.Join(t.TempDir(), "source.db"), "--set-dir", filepath.Join(t.TempDir(), "set"), "--total-bytes", "1048576", "--total-rows", "100", "--part-bytes", "65536", "--part-rows", "10", "--record-bytes", "8192", "--parts", "32", "--timeout", "1m", "--disk-bytes", "268435456"}
	if err := runBackupSet(context.Background(), args, neverReadPassword{t}, io.Discard, func(string) string { return "synthetic-invalid-secret" }); err == nil || strings.Contains(err.Error(), "synthetic-invalid-secret") {
		t.Fatal("invalid key accepted or reflected", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runBackupSet(ctx, args, neverReadPassword{t}, io.Discard, func(string) string { return strings.Repeat("ab", 32) }); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled command started", err)
	}
}
