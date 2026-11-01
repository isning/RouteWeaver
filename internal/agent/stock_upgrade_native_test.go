//go:build linux

package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
)

// Actual official old/new bytes exercise the process transition, not a synthetic
// version fixture. All listeners and traffic stay on loopback.
func TestNativeStockXrayUpgradeKeepsExactRuntimeAndLease(t *testing.T) {
	testNativeStockUpgrade(t, "xray", "xray-26.3.27-linux-amd64", "xray-26.10.31-linux-amd64")
}

// Historical installed receipts remain recoverable; this does not make 1.14.3
// available for new installation or claim it is free of known vulnerabilities.
func TestNativeStockSingBoxUpgradeKeepsExactRuntimeAndLease(t *testing.T) {
	testNativeStockUpgrade(t, "sing-box", "sing-box-1.14.3-linux-amd64", "sing-box-1.14.4-linux-amd64")
}

func testNativeStockUpgrade(t *testing.T, core, oldID, currentID string) {
	t.Helper()
	cache := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if cache == "" || !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ","+core+",") {
		t.Skip("explicit exact-cache process opt-in required")
	}
	for _, failNew := range []bool{false, true} {
		t.Run(fmt.Sprintf("failed-new=%t", failNew), func(t *testing.T) {
			ctx := context.Background()
			old, err := controlprotocol.FindCoreRelease(oldID)
			if err != nil {
				t.Fatal(err)
			}
			current, err := controlprotocol.FindInstallableCoreRelease(currentID)
			if err != nil {
				t.Fatal(err)
			}
			if old.Version == current.Version || old.ExecutableSHA256 == current.ExecutableSHA256 {
				t.Fatal("upgrade must use distinct official versions and bytes")
			}
			downloads := 0
			installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(_ context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
				downloads++
				return os.Open(filepath.Join(cache, r.ID+".download"))
			}})
			if err != nil {
				t.Fatal(err)
			}
			bytes, err := os.ReadFile(filepath.Join(cache, old.ID))
			if err != nil {
				t.Fatal(err)
			}
			if digestBytes(bytes) != old.ExecutableSHA256 {
				t.Fatal("old runtime cache differs from immutable pin")
			}
			dir := filepath.Join(installer.root, old.ID+"-"+old.ExecutableSHA256)
			if err = os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(dir, "core"), bytes, 0500); err != nil {
				t.Fatal(err)
			}
			if err = writeJSON(filepath.Join(dir, "release.json"), old); err != nil {
				t.Fatal(err)
			}
			now := time.Now().UTC()
			supervisor := &SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: 2 * time.Second}
			options := Options{CoreInstaller: installer, InstallSupervisor: supervisor, MaxLease: 2 * time.Hour, Now: func() time.Time { return now }}
			root := t.TempDir()
			if err = os.Chmod(root, 0700); err != nil {
				t.Fatal(err)
			}
			first := nativeDesired(t, old.AdapterID, old.Version)
			first.Lease.IssuedAt = now.Add(-time.Second)
			first.Lease.ExpiresAt = now.Add(time.Hour)
			port := freeLoopbackPort(t)
			config := func(p int) string {
				if core == "sing-box" {
					return fmt.Sprintf(`{"inbounds":[{"type":"socks","listen":"127.0.0.1","listen_port":%d,"users":[{"username":"fixture","password":"local-only"}]}],"outbounds":[{"type":"direct","tag":"direct"}]}`, p)
				}
				return fmt.Sprintf(`{"inbounds":[{"listen":"127.0.0.1","port":%d,"protocol":"socks","settings":{"auth":"password","accounts":[{"user":"fixture","pass":"local-only"}]}}],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`, p)
			}
			first.Artifacts[0].Content = config(port)
			first.Digest, _ = ArtifactDigest(first.Artifacts)
			registry := NewRegistry()
			r, err := Open(root, first.Scope, registry, options)
			if err != nil {
				t.Fatal(err)
			}
			// Open snapshots its input. Retain the actual instance registry that
			// installation populates, independently of r being closed/reopened.
			cleanupRegistry := r.registry
			t.Cleanup(func() {
				stopCtx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
				defer cancel()
				if e := r.Close(); e != nil {
					t.Error(e)
				}
				// Open can fail after Close (for example a damaged agent journal).
				// Cleanup uses the separately verified process journal, not a live
				// reconciler or a blind PID signal, and reacquires the instance lock.
				if e := cleanupStockUpgradeOwned(stopCtx, root, cleanupRegistry); e != nil {
					t.Error(e)
				}
			})
			echo, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer echo.Close()
			go func() {
				for {
					c, e := echo.Accept()
					if e != nil {
						return
					}
					go func() { defer c.Close(); c.SetDeadline(time.Now().Add(3 * time.Second)); io.Copy(c, c) }()
				}
			}()
			traffic := func(want bool) {
				t.Helper()
				c, e := socksFixtureConnect(fmt.Sprintf("127.0.0.1:%d", port), echo.Addr().(*net.TCPAddr).Port)
				if !want {
					if e == nil {
						c.Close()
						t.Fatal("expired old lease retained traffic")
					}
					return
				}
				if e != nil {
					t.Fatal(e)
				}
				defer c.Close()
				payload := "exact-official-transition"
				if _, e = io.WriteString(c, payload); e != nil {
					t.Fatal(e)
				}
				out := make([]byte, len(payload))
				if _, e = io.ReadFull(c, out); e != nil || string(out) != payload {
					t.Fatal("transition payload mismatch", e)
				}
			}
			state, err := r.Submit(ctx, first)
			if err != nil || state.Observed == nil || state.Observed.Identity != first.Identity() {
				t.Fatalf("old runtime: %+v %v", state, err)
			}
			traffic(true)
			next := first
			next.Artifacts = append([]domain.Artifact(nil), first.Artifacts...)
			next.Generation = 2
			next.OperationID = "upgrade"
			next.RevisionID = "upgrade"
			next.Action = "upgrade"
			next.CoreVersion = current.Version
			next.CoreReleaseID = current.ID
			next.Transition = &controlprotocol.CoreTransition{From: first.Identity(), ReleaseID: current.ID, ExecutableSHA256: current.ExecutableSHA256}
			next.Lease.IssuedAt = now
			next.Lease.ExpiresAt = now.Add(90 * time.Minute)
			if failNew {
				occupied, e := net.Listen("tcp", "127.0.0.1:0")
				if e != nil {
					t.Fatal(e)
				}
				defer occupied.Close()
				next.Artifacts[0].Content = config(occupied.Addr().(*net.TCPAddr).Port)
			}
			next.Digest, _ = ArtifactDigest(next.Artifacts)
			state, err = r.Submit(ctx, next)
			if failNew {
				if !errors.Is(err, ErrUnknownRuntime) || state.Phase != Unknown || !state.RecoveryRequired || state.Observed != nil {
					t.Fatalf("failed launch claimed a known restored owner: %+v %v", state, err)
				}
				state, err = r.Recover(ctx)
				if err != nil || state.Phase != ApplyFailed || state.Code != "recovered_not_applied" || state.RecoveryRequired || state.Observed != nil {
					t.Fatalf("failed launch recovery did not prove absence: %+v %v", state, err)
				}
				for _, release := range []controlprotocol.CoreRelease{old, current} {
					adapter, e := r.registry.Get(release.AdapterID, release.Version)
					if e != nil {
						t.Fatal(e)
					}
					observation, e := adapter.Observe(ctx, root)
					if e != nil || !observation.Known || !observation.Quiescent || observation.Generation != 0 {
						t.Fatalf("failed launch orphan or unknown owner: %s %+v %v", release.ID, observation, e)
					}
				}
				traffic(false)
				// Failure restores the pointer, not permissions or a process. An
				// explicit historical rollback must still satisfy the current lease.
				now = first.Lease.ExpiresAt.Add(time.Second)
				rollback := first
				rollback.Generation = 3
				rollback.OperationID = "expired-rollback"
				rollback.RevisionID = "expired-rollback"
				rollback.Action = "rollback"
				rollback.CoreReleaseID = old.ID
				state, err = r.Submit(ctx, rollback)
				if !errors.Is(err, ErrLeaseBlocked) || state.Observed != nil {
					t.Fatalf("rollback revived expired old grant: %+v %v", state, err)
				}
				traffic(false)
				rollback.Generation = 4
				rollback.OperationID = "current-rollback"
				rollback.RevisionID = "current-rollback"
				rollback.Lease.IssuedAt = now
				rollback.Lease.ExpiresAt = now.Add(time.Hour)
				state, err = r.Submit(ctx, rollback)
				if err != nil || state.Observed == nil || state.Observed.Identity != rollback.Identity() {
					t.Fatalf("fresh explicit rollback did not restore exact historical runtime: %+v %v", state, err)
				}
				traffic(true)
				now = rollback.Lease.ExpiresAt.Add(time.Second)
				state, err = r.EnforcePolicy(ctx)
				if !errors.Is(err, ErrLeaseBlocked) || state.Observed != nil {
					t.Fatalf("restored old runtime ignored lease fence: %+v %v", state, err)
				}
				traffic(false)
			} else {
				if err != nil || state.Phase != ObservedConformant || state.Observed == nil || state.Observed.Identity != next.Identity() || state.Installation == nil || state.Installation.ExecutableSHA256 != current.ExecutableSHA256 {
					t.Fatalf("current runtime not exact: %+v %v", state, err)
				}
				traffic(true)
				if err = r.Close(); err != nil {
					t.Fatal(err)
				}
				reopened, err := Open(root, first.Scope, NewRegistry(), options)
				if err != nil {
					t.Fatal(err)
				}
				r = reopened
				state, err = r.Recover(ctx)
				if err != nil || state.Observed == nil || state.Observed.Identity != next.Identity() {
					t.Fatalf("new receipt restart lost exact owner: %+v %v", state, err)
				}
				traffic(true)
			}
			if downloads != 1 {
				t.Fatalf("transition fetched historical bytes or redownloaded current: %d", downloads)
			}
		})
	}
}

// cleanupStockUpgradeOwned is test cleanup independent of Reconciler.Close.
// The registry is retained from the original installer; process identity chooses
// the exact adapter, whose Restrict checks the durable OS identity before signals.
func cleanupStockUpgradeOwned(ctx context.Context, root string, registry *Registry) error {
	lock, err := lockRoot(root)
	if err != nil {
		return err
	}
	defer unlockRoot(lock)
	var process processRecord
	if err := readJSON(processFile(root), &process); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	adapter, err := registry.Get(process.Identity.AdapterID, process.Identity.CoreVersion)
	if err != nil {
		return err
	}
	restrictor, ok := adapter.(PolicyRestrictor)
	if !ok {
		return ErrUnsupportedActivation
	}
	if err := restrictor.Restrict(ctx, root); err != nil {
		return err
	}
	observation, err := adapter.Observe(ctx, root)
	if err != nil {
		return err
	}
	if !observation.Known || !observation.Quiescent || observation.Generation != 0 {
		return ErrUnknownRuntime
	}
	return nil
}

// Disk simulation only: no native process, listener, or external binary runs.
func TestStockUpgradeCleanupAfterClosedRuntimeAndFailedReopen(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	a := LocalFixture{}
	d := testDesired(t, 1)
	callerRegistry := NewRegistry()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	r, err := Open(root, d.Scope, callerRegistry, Options{MaxLease: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	// Simulate the installer's instance-local registration, without native bytes.
	if err := r.registry.Register(a); err != nil {
		t.Fatal(err)
	}
	if _, err := callerRegistry.Get(d.AdapterID, d.CoreVersion); err == nil {
		t.Fatal("Open unexpectedly shared the caller registry")
	}
	registry := r.registry
	if _, err := r.Submit(ctx, d); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(processFile(root), processRecord{Identity: d.Identity()}); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "state.json"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if reopened, err := Open(root, d.Scope, NewRegistry(a), Options{MaxLease: 2 * time.Hour}); err == nil {
		reopened.Close()
		t.Fatal("expected failed reopen")
	}
	if _, err := r.StopOwned(ctx); err == nil {
		t.Fatal("closed reconciler unexpectedly usable")
	}
	lock, err := lockRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := cleanupStockUpgradeOwned(ctx, root, registry); err == nil {
		t.Error("cleanup ignored another instance lock")
	}
	unlockRoot(lock)
	if obs, err := a.Observe(ctx, root); err != nil || obs.Generation != 1 {
		t.Fatal("blocked cleanup altered owner", obs, err)
	}
	if err := cleanupStockUpgradeOwned(ctx, root, registry); err != nil {
		t.Fatal(err)
	}
	if obs, err := a.Observe(ctx, root); err != nil || !obs.Known || !obs.Quiescent || obs.Generation != 0 {
		t.Fatal("independent cleanup did not prove absence", obs, err)
	}
}
