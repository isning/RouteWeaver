package store_test

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"routeweaver/internal/store"
)

func TestFirstOpenAcrossProcesses(t *testing.T) {
	if path := os.Getenv("ROUTEWEAVER_TEST_FIRST_OPEN_DB"); path != "" {
		input := bufio.NewScanner(os.Stdin)
		fmt.Println("ready")
		if !input.Scan() {
			t.Fatal("missing start")
		}
		s, err := store.Open(path, make([]byte, 32))
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		if err = s.Put("audit", os.Getenv("ROUTEWEAVER_TEST_FIRST_OPEN_ID"), map[string]bool{"kept": true}); err != nil {
			t.Fatal(err)
		}
		if err = s.Ready(context.Background()); err != nil {
			t.Fatal(err)
		}
		fmt.Println("opened")
		if !input.Scan() {
			t.Fatal("missing close")
		}
		return
	}
	path := filepath.Join(t.TempDir(), "state.db")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmds := make([]*exec.Cmd, 4)
	ins := make([]io.WriteCloser, 4)
	outs := make([]*bufio.Scanner, 4)
	stderr := make([]bytes.Buffer, 4)
	t.Cleanup(func() {
		cancel()
		for _, cmd := range cmds {
			if cmd != nil && cmd.Process != nil && cmd.ProcessState == nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
			}
		}
	})
	for i := range cmds {
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestFirstOpenAcrossProcesses$", "-test.count=1", "-test.timeout=20s")
		cmd.Env = append(os.Environ(), "ROUTEWEAVER_TEST_FIRST_OPEN_DB="+path, fmt.Sprintf("ROUTEWEAVER_TEST_FIRST_OPEN_ID=child-%d", i))
		cmd.Stderr = &stderr[i]
		var err error
		ins[i], err = cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		outs[i] = bufio.NewScanner(out)
		cmds[i] = cmd
		if err = cmd.Start(); err != nil {
			t.Fatal(err)
		}
	}
	stopChild := func(i int) string {
		// os/exec may still be copying stderr. Wait before inspecting its buffer,
		// including on a failed handshake, so failure diagnostics are race-safe.
		_ = cmds[i].Process.Kill()
		_ = cmds[i].Wait()
		return stderr[i].String()
	}
	for i, out := range outs {
		if !out.Scan() || out.Text() != "ready" {
			t.Fatalf("child %d not ready: %s %s", i, out.Text(), stopChild(i))
		}
	}
	for _, in := range ins {
		if _, err := fmt.Fprintln(in, "start"); err != nil {
			t.Fatal(err)
		}
	}
	for i, out := range outs {
		if !out.Scan() || out.Text() != "opened" {
			t.Fatalf("child %d open: %s %s", i, out.Text(), stopChild(i))
		}
	}
	for _, in := range ins {
		if _, err := fmt.Fprintln(in, "close"); err != nil {
			t.Fatal(err)
		}
		in.Close()
	}
	for i, cmd := range cmds {
		if err := cmd.Wait(); err != nil {
			t.Fatalf("child %d: %v %s", i, err, stderr[i].String())
		}
	}
	s, err := store.Open(path, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := range cmds {
		var got map[string]bool
		if err = s.Get("audit", fmt.Sprintf("child-%d", i), &got); err != nil || !got["kept"] {
			t.Fatalf("child %d write lost: %v %v", i, got, err)
		}
	}
	if err = s.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestFirstOpenWALContentionIsBoundedAndRecoverable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(kind,id))`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRow(`SELECT count(*) FROM records`).Scan(&count); err != nil {
		t.Fatal(err)
	} // Keep a real rollback-journal read lock.
	start := time.Now()
	s, openErr := store.Open(path, make([]byte, 32))
	if s != nil {
		s.Close()
		t.Fatal("Open succeeded while WAL transition was blocked")
	}
	if !errors.Is(openErr, context.DeadlineExceeded) {
		t.Fatalf("expected bounded WAL contention, got %v", openErr)
	}
	var code interface{ Code() int }
	if !errors.As(openErr, &code) || code.Code()&255 != 5 {
		t.Fatalf("original SQLite BUSY lost: %v", openErr)
	}
	if elapsed := time.Since(start); elapsed < 4500*time.Millisecond || elapsed > 8*time.Second {
		t.Fatalf("WAL contention did not honor its single wait budget: %v", elapsed)
	}
	if err = tx.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("failed Open migrated schema: %d %v", count, err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Put("audit", "after-contention", map[string]bool{"ok": true}); err != nil {
		t.Fatal(err)
	}
	if err = s.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestFirstOpenWaitsForReaderAndRestoresWriterWait(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(kind,id))`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRow(`SELECT count(*) FROM records`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	type result struct {
		s   *store.Store
		err error
	}
	opened := make(chan result, 1)
	go func() { s, err := store.Open(path, make([]byte, 32)); opened <- result{s, err} }()
	select {
	case r := <-opened:
		if r.s != nil {
			r.s.Close()
		}
		t.Fatalf("Open returned before reader release: %v", r.err)
	case <-time.After(100 * time.Millisecond):
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var s *store.Store
	select {
	case r := <-opened:
		if r.err != nil {
			t.Fatal(r.err)
		}
		s = r.s
	case <-time.After(8 * time.Second):
		t.Fatal("Open did not recover after reader release")
	}
	defer s.Close()
	tx, err = db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); err != nil {
		t.Fatal(err)
	}
	written := make(chan error, 1)
	go func() { written <- s.Put("audit", "writer-wait", map[string]bool{"ok": true}) }()
	select {
	case err = <-written:
		t.Fatalf("normal write returned before lock release: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-written:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("writer timeout was not restored")
	}
	if err = s.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestUnsupportedSchemaDoesNotNegotiateWAL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "future.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE future_only(value TEXT)`); err != nil {
		t.Fatal(err)
	}
	var before, after string
	if err = db.QueryRow(`PRAGMA journal_mode`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	s, openErr := store.Open(path, make([]byte, 32))
	if s != nil {
		s.Close()
		t.Fatal("unknown schema accepted")
	}
	if !errors.Is(openErr, store.ErrUnsupportedSchema) {
		t.Fatalf("wrong refusal: %v", openErr)
	}
	if err = db.QueryRow(`PRAGMA journal_mode`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != "delete" || after != before {
		t.Fatalf("rejected database journal mode changed: %s -> %s", before, after)
	}
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rejected database schema changed: %d %v", count, err)
	}
}
