package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func publicationFixture(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	path, target := filepath.Join(dir, "stage.db"), filepath.Join(dir, "restore.db")
	if err := os.WriteFile(path, []byte("synthetic verified store"), 0600); err != nil {
		t.Fatal(err)
	}
	return path, target
}

func TestBackupPublicationCancelledBeforeLinkDoesNotPublish(t *testing.T) {
	path, target := publicationFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := publishFreshBackup(ctx, path, target)
	if !errors.Is(err, context.Canceled) || errors.Is(err, ErrRestorePublicationUncertain) {
		t.Fatalf("expected known prepublication cancellation, got %v", err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("cancelled attempt created target: %v", err)
	}
}

func TestBackupPublicationNeverReplacesExistingTarget(t *testing.T) {
	path, target := publicationFixture(t)
	if err := os.WriteFile(target, []byte("existing target"), 0600); err != nil {
		t.Fatal(err)
	}
	err := publishFreshBackup(context.Background(), path, target)
	if err == nil || errors.Is(err, ErrRestorePublicationUncertain) {
		t.Fatalf("expected known no-replace failure, got %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "existing target" {
		t.Fatalf("occupied target changed: %q %v", got, err)
	}
}

func TestBackupPublicationPostLinkFailureRemainsUncertainAfterCleanup(t *testing.T) {
	for _, cleanupFails := range []bool{false, true} {
		name := "cleanup_removed_target"
		if cleanupFails {
			name = "cleanup_failed_target_remains"
		}
		t.Run(name, func(t *testing.T) {
			path, target := publicationFixture(t)
			publicationErr := errors.New("synthetic parent open or sync failure")
			cleanupErr := errors.New("synthetic cleanup failure")
			ops := backupPublicationOps{
				link:       os.Link,
				syncParent: func(string) error { return publicationErr },
				remove: func(path string) error {
					if cleanupFails {
						return cleanupErr
					}
					return os.Remove(path)
				},
			}
			err := publishFreshBackupWithOps(context.Background(), path, target, ops)
			var outcome *RestorePublicationUncertainError
			if !errors.Is(err, ErrRestorePublicationUncertain) || !errors.As(err, &outcome) || !errors.Is(err, publicationErr) {
				t.Fatalf("lost post-link uncertainty/cause: %v", err)
			}
			if errors.Is(err, cleanupErr) != cleanupFails {
				t.Fatalf("cleanup cause mismatch: %v", err)
			}
			_, statErr := os.Stat(target)
			if cleanupFails && statErr != nil {
				t.Fatalf("expected linked target remaining: %v", statErr)
			}
			if !cleanupFails && !os.IsNotExist(statErr) {
				t.Fatalf("cleanup did not remove target: %v", statErr)
			}
			if err.Error() != "restore publication outcome is uncertain" {
				t.Fatalf("public error exposed local cause: %v", err)
			}
		})
	}
}

func TestBackupPublicationDurableSuccessSurvivesContextExpiryAfterLink(t *testing.T) {
	path, target := publicationFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ops := backupPublicationOps{
		link: func(path, target string) error {
			err := os.Link(path, target)
			cancel() // Models expiry during noninterruptible final publication.
			return err
		},
		syncParent: syncBackupParent,
		remove: func(string) error {
			t.Error("durable success attempted cleanup")
			return nil
		},
	}
	if err := publishFreshBackupWithOps(ctx, path, target, ops); err != nil {
		t.Fatalf("durable result recategorized as failure: %v", err)
	}
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatal("test did not cancel operation context")
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "synthetic verified store" {
		t.Fatalf("durable target missing: %q %v", got, err)
	}
}

func TestBackupPublicationSuccessfulSyncCloseErrorDoesNotRemoveTarget(t *testing.T) {
	path, target := publicationFixture(t)
	closed := false
	err := publishFreshBackupWithOps(context.Background(), path, target, backupPublicationOps{
		link: os.Link,
		syncParent: func(string) error {
			return syncAndCloseBackupParent(func() error { return nil }, func() error { closed = true; return errors.New("synthetic close failure") })
		},
		remove: func(string) error { t.Error("durable publication was removed after close error"); return nil },
	})
	if err != nil || !closed {
		t.Fatalf("durable result changed or close omitted: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("published target missing")
	}
}
