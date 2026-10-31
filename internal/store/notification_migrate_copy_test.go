package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// Cancel between the first and second bounded backup step. This adapter-level
// seam avoids a timing race or introducing a production-only test hook.
type notificationCopyCancelContext struct {
	context.Context
	calls  int
	cancel context.CancelFunc
}

func (c *notificationCopyCancelContext) Err() error {
	c.calls++
	if c.calls == 2 {
		c.cancel()
	}
	return c.Context.Err()
}
func TestNotificationOnlineCopyCancelsBetweenBatchesAndReleasesTarget(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source.db")
	copyPath := filepath.Join(t.TempDir(), "owned-copy.db")
	db, err := sql.Open("sqlite", source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE payload(data BLOB); INSERT INTO payload VALUES(zeroblob(2097152))`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	uri := url.URL{Scheme: "file", Path: source, RawQuery: "mode=ro"}
	ro, err := sql.Open("sqlite", uri.String())
	if err != nil {
		t.Fatal(err)
	}
	defer ro.Close()
	conn, err := ro.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err = conn.ExecContext(context.Background(), "BEGIN"); err != nil {
		t.Fatal(err)
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx := &notificationCopyCancelContext{Context: base, cancel: cancel}
	if err = copyNotificationMigrationSnapshot(ctx, conn, copyPath); !errors.Is(err, context.Canceled) {
		t.Fatalf("bounded copy did not cancel: %v", err)
	}
	if ctx.calls != 2 {
		t.Fatalf("expected cancellation after first128-page batch, got%d checks", ctx.calls)
	}
	after, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("cancelled readonly copy changed source")
	}
	// Finish must release the destination's backup transaction/connection.
	target, err := sql.Open("sqlite", copyPath)
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	if _, err = target.Exec(`CREATE TABLE after_cancellation(ok INTEGER)`); err != nil {
		t.Fatalf("cancelled backup retained destination lock: %v", err)
	}
}
