package store

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestNotificationProviderSnapshotHonorsMutexDeadline(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{79}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.mu.Lock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := s.NotificationProviderInputs(ctx); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("error=%v", err)
		}
	case <-time.After(time.Second):
		s.mu.Unlock()
		t.Fatal("provider snapshot ignored deadline")
	}
	s.mu.Unlock()
}
func TestNotificationProviderSnapshotRejectsMismatchedIdentity(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{82}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.Put("hosts", "row", map[string]string{"id": "other"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.NotificationProviderInputs(context.Background()); err == nil {
		t.Fatal("joined observations with a different payload identity")
	}
}
