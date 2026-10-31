package main

import (
	"bytes"
	"context"
	"path/filepath"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

func TestNotificationMigrateRequiresExplicitReviewedBudgets(t *testing.T) {
	t.Setenv("ROUTEWEAVER_MASTER_KEY", strings.Repeat("00", 32))
	for _, args := range [][]string{
		{}, {"--source", "source", "--output", "output"},
		{"--source", "source", "--output", "output", "--max-record-bytes", "268435457", "--memory-budget-bytes", "3000000000"},
		{"--source", "source", "--output", "output", "--max-record-bytes", "1024", "--memory-budget-bytes", "1024"},
		{"--source", "source", "--output", "output", "--max-record-bytes", "1024", "--memory-budget-bytes", "300000000", "--timeout", "0s"},
		{"--source", "source", "--output", "output", "--max-record-bytes", "1024", "--memory-budget-bytes", "300000000", "--timeout", "2h"},
	} {
		if err := run(context.Background(), args, &bytes.Buffer{}); err == nil {
			t.Fatalf("unsafe arguments accepted: %v", args)
		}
	}
}
func TestNotificationMigrateCommandCreatesSeparateDatabase(t *testing.T) {
	t.Setenv("ROUTEWEAVER_MASTER_KEY", strings.Repeat("00", 32))
	source := filepath.Join(t.TempDir(), "source.db")
	output := filepath.Join(t.TempDir(), "output.db")
	s, err := store.Open(source, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Put("notification-private", "state", notifications.DefaultState()); err != nil {
		t.Fatal(err)
	}
	s.Close()
	out := &bytes.Buffer{}
	if err = run(context.Background(), []string{"--source", source, "--output", output, "--max-record-bytes", "1048576", "--memory-budget-bytes", "276824064", "--timeout", "1m"}, out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "No service was activated") {
		t.Fatal("missing non-activation receipt")
	}
	target, err := store.Open(output, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	target.Close()
}
