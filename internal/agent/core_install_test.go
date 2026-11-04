package agent

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"routeweaver/internal/controlprotocol"
)

func TestCoreInstallerRejectsUnpinnedReleaseAndCorruptArchive(t *testing.T) {
	calls := 0
	installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(context.Context, controlprotocol.CoreRelease) (io.ReadCloser, error) {
		calls++
		return io.NopCloser(strings.NewReader("not the official archive")), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = installer.Prepare(context.Background(), "unreviewed-core-9-linux-amd64"); err == nil {
		t.Fatal("unlisted release was installed")
	}
	if calls != 0 {
		t.Fatal("unknown release triggered download")
	}
	if _, err = installer.Prepare(context.Background(), "xray-26.10.31-linux-amd64"); err == nil {
		t.Fatal("corrupted official archive was installed")
	}
	if calls != 1 {
		t.Fatal("official archive source was not used")
	}
}

func TestNativeCoreInstallerPreparesImmutableOfficialExecutables(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not configured")
	}
	for _, release := range controlprotocol.InstallableCoreReleases() {
		t.Run(release.ID, func(t *testing.T) {
			calls := 0
			installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(_ context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
				calls++
				name := r.ID
				return os.Open(filepath.Join(cache, name+".download"))
			}})
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := installer.Prepare(context.Background(), release.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(prepared.Executable, release.ExecutableSHA256) {
				t.Fatal("executable path is not immutable digest addressed")
			}
			again, err := installer.Prepare(context.Background(), release.ID)
			if err != nil || again != prepared || calls != 1 {
				t.Fatalf("repeat installed or altered immutable executable: %+v %v calls=%d", again, err, calls)
			}
			checker, err := NewInstalledNativeChecker(prepared, time.Second*5)
			if err != nil {
				t.Fatal(err)
			}
			d := nativeDesired(t, release.AdapterID, release.Version)
			if release.AdapterID == "routeweaver/xray" {
				d.Artifacts[0].Content = `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`
			} else {
				d.Artifacts[0].Content = `{"inbounds":[],"outbounds":[{"type":"direct","tag":"direct"}]}`
			}
			d.Digest, _ = ArtifactDigest(d.Artifacts)
			reconciler := openTest(t, t.TempDir(), checker)
			state, err := reconciler.Submit(context.Background(), d)
			if !errors.Is(err, ErrUnsupportedActivation) || !state.NativeChecked || state.Observed != nil {
				t.Fatalf("prepared official native check: %+v %v", state, err)
			}
			if err = os.Chmod(prepared.Executable, 0700); err != nil {
				t.Fatal(err)
			}
			if err = atomicWrite(prepared.Executable, []byte("corruption"), 0500); err != nil {
				t.Fatal(err)
			}
			if _, err = installer.Prepare(context.Background(), release.ID); err == nil {
				t.Fatal("changed immutable binary was reused")
			}
		})
	}
}

func TestNativeInstallDesiredPreservesActiveRuntimeAndLease(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not configured")
	}
	installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(_ context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
		return os.Open(filepath.Join(cache, r.ID+".download"))
	}})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	os.Chmod(root, 0700)
	r, err := Open(root, testDesired(t, 1).Scope, NewRegistry(LocalFixture{}), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	old := testDesired(t, 1)
	if _, err = r.Submit(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	install := testDesired(t, 2)
	install.Action = "install"
	install.AdapterID = "routeweaver/xray"
	install.CoreVersion = "26.10.31"
	install.CoreReleaseID = "xray-26.10.31-linux-amd64"
	install.Lease.AccessAllowed = false
	install.Artifacts[0].Content = `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`
	install.Digest, _ = ArtifactDigest(install.Artifacts)
	state, err := r.Submit(context.Background(), install)
	if err != nil || state.Phase != "installed" || state.Code != "artifact_installed" || state.Installation == nil || state.Installation.ReleaseID != install.CoreReleaseID || state.Observed == nil || state.Observed.Identity != old.Identity() {
		t.Fatalf("install altered running generation: %+v %v", state, err)
	}
	if state, err = r.EnforcePolicy(context.Background()); err != nil || state.Observed == nil || state.Observed.Identity != old.Identity() {
		t.Fatalf("installation policy overwrote active lease: %+v %v", state, err)
	}
	r.Close()
	r, err = Open(root, old.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if state, err = r.Recover(context.Background()); err != nil || state.Phase != "installed" || state.Observed == nil || state.Observed.Identity != old.Identity() {
		t.Fatalf("install restart failed to retain actual old runtime: %+v %v", state, err)
	}
}

func TestNativeInstallDoesNotEraseAcceptedRevocation(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not configured")
	}
	installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(_ context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
		return os.Open(filepath.Join(cache, r.ID+".download"))
	}})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	os.Chmod(root, 0700)
	r, err := Open(root, testDesired(t, 1).Scope, NewRegistry(LocalFixture{}), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	first := testDesired(t, 1)
	if _, err = r.Submit(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	denied := testDesired(t, 2)
	denied.Action = "stop"
	denied.Lease.AccessAllowed = false
	denied.Lease.Revision = "revoked-policy"
	if _, err = r.Submit(context.Background(), denied); !errors.Is(err, ErrLeaseBlocked) {
		t.Fatal(err)
	}
	install := testDesired(t, 3)
	install.Action = "install"
	install.AdapterID = "routeweaver/xray"
	install.CoreVersion = "26.10.31"
	install.CoreReleaseID = "xray-26.10.31-linux-amd64"
	install.Artifacts[0].Content = `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`
	install.Digest, _ = ArtifactDigest(install.Artifacts)
	if state, err := r.Submit(context.Background(), install); err != nil || state.Phase != "installed" || state.Observed != nil {
		t.Fatalf("install after revocation: %+v %v", state, err)
	}
	if state, err := r.CheckAccess(); !errors.Is(err, ErrLeaseBlocked) || state.AccessDecision != "access_denied" || state.Phase != "installed" || state.Installation == nil {
		t.Fatalf("install cleared durable revocation: %+v %v", state, err)
	}
	if state, err := r.EnforcePolicy(context.Background()); !errors.Is(err, ErrLeaseBlocked) || state.AccessDecision != "access_denied" || state.Phase != "installed" || state.Installation == nil || state.Observed != nil {
		t.Fatalf("revocation erased independent completed installation evidence: %+v %v", state, err)
	}
}

func TestCoreInstallerRejectsRootReplacementBeforeFetching(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cores")
	calls := 0
	installer, err := NewCoreInstaller(root, CoreInstallerOptions{OpenArchive: func(context.Context, controlprotocol.CoreRelease) (io.ReadCloser, error) {
		calls++
		return io.NopCloser(strings.NewReader("invalid")), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(t.TempDir(), root); err != nil {
		t.Fatal(err)
	}
	if _, err = installer.Prepare(context.Background(), "xray-26.10.31-linux-amd64"); err == nil || calls != 0 {
		t.Fatal("replaced core root was followed or fetched")
	}
}

func TestNativeInstallDownloadCannotDelayActiveLeaseExpiry(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not configured")
	}
	first := testDesired(t, 1)
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	now := func() time.Time { return time.Unix(0, clock.Load()) }
	first.Lease.ExpiresAt = now().Add(80 * time.Millisecond)
	fetching := make(chan struct{})
	releaseFetch := make(chan struct{})
	installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(ctx context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
		close(fetching)
		select {
		case <-releaseFetch:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return os.Open(filepath.Join(cache, r.ID+".download"))
	}})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	os.Chmod(root, 0700)
	runtime := LocalFixture{}
	r, err := Open(root, first.Scope, NewRegistry(runtime), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err = r.Submit(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	install := testDesired(t, 2)
	install.Action = "install"
	install.AdapterID = "routeweaver/xray"
	install.CoreVersion = "26.10.31"
	install.CoreReleaseID = "xray-26.10.31-linux-amd64"
	install.Artifacts[0].Content = `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`
	install.Digest, _ = ArtifactDigest(install.Artifacts)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := r.Submit(ctx, install); done <- err }()
	joined := false
	// Unblock archive retrieval and join Submit before closing the reconciler,
	// including assertion failures while the download holds the mutation lane.
	defer func() {
		cancel()
		if !joined {
			<-done
		}
	}()
	select {
	case <-fetching:
	case err := <-done:
		joined = true
		t.Fatalf("installation returned before entering archive retrieval: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("installation never entered archive retrieval")
	}
	if observation, err := runtime.Observe(context.Background(), root); err != nil || !observation.Known || !observation.Quiescent || observation.Identity != first.Identity() {
		t.Fatalf("original runtime was not active before lease expiry: %+v %v", observation, err)
	}
	// Policy time stays fixed through durable setup and the download barrier.
	// Expire the original 80 ms lease exactly at its boundary; the production
	// preparation ticker and the 300 ms restriction bound still use real time.
	deadline := time.Now().Add(300 * time.Millisecond)
	clock.Store(first.Lease.ExpiresAt.UnixNano())
	expired := false
	for time.Now().Before(deadline) {
		observation, err := runtime.Observe(context.Background(), root)
		if err == nil && observation.Known && observation.Quiescent && observation.Generation == 0 {
			expired = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case err := <-done:
		joined = true
		t.Fatalf("installation returned while archive retrieval was blocked: %v", err)
	default:
	}
	close(releaseFetch)
	err = <-done
	joined = true
	if err != nil {
		t.Fatal(err)
	}
	if !expired {
		t.Fatal("slow archive retrieval kept old runtime alive beyond its original lease")
	}
	if state := r.State(); state.Phase != "installed" || state.Installation == nil || state.Observed != nil || state.AccessDecision != "lease_expired" {
		t.Fatalf("installation did not preserve the expired active-runtime policy: %+v", state)
	}
}

func TestNativeInstallDoesNotMutateAnotherInstancesRegistry(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not configured")
	}
	installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(_ context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
		return os.Open(filepath.Join(cache, r.ID+".download"))
	}})
	if err != nil {
		t.Fatal(err)
	}
	shared := NewRegistry(LocalFixture{})
	root := t.TempDir()
	os.Chmod(root, 0700)
	r, err := Open(root, testDesired(t, 1).Scope, shared, Options{MaxLease: 2 * time.Hour, CoreInstaller: installer})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	install := testDesired(t, 1)
	install.Action = "install"
	install.AdapterID = "routeweaver/xray"
	install.CoreVersion = "26.10.31"
	install.CoreReleaseID = "xray-26.10.31-linux-amd64"
	install.Artifacts[0].Content = `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`
	install.Digest, _ = ArtifactDigest(install.Artifacts)
	if _, err = r.Submit(context.Background(), install); err != nil {
		t.Fatal(err)
	}
	if _, err = shared.Get(install.AdapterID, install.CoreVersion); err == nil {
		t.Fatal("one instance changed the caller's shared runtime registry")
	}
}

// A historical pin remains useful to verify existing receipts, not to authorize
// a new installation after its security retirement.
func TestCoreInstallerRejectsRetiredReleaseBeforeOpeningArchive(t *testing.T) {
	for _, id := range []string{"xray-26.3.27-linux-amd64", "sing-box-1.14.3-linux-amd64", "xray-26.10.29-linux-amd64"} {
		t.Run(id, func(t *testing.T) {
			calls := 0
			installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(context.Context, controlprotocol.CoreRelease) (io.ReadCloser, error) {
				calls++
				return io.NopCloser(strings.NewReader("must not download")), nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := installer.Prepare(context.Background(), id); err == nil || calls != 0 {
				t.Fatalf("retired release attempted preparation: err=%v downloads=%d", err, calls)
			}
			if _, err := controlprotocol.FindCoreRelease(id); err != nil {
				t.Fatal("historical identity lost", err)
			}
		})
	}
}

// Simulate an authentic pre-retirement journal, rather than weakening the new
// admission guard to manufacture history through Submit.
func TestRetiredPendingInstallAndUpgradeRecoverWithoutReplaying(t *testing.T) {
	for _, id := range []string{"xray-26.3.27-linux-amd64", "sing-box-1.14.3-linux-amd64", "xray-26.10.29-linux-amd64"} {
		for _, action := range []string{"install", "upgrade"} {
			t.Run(id+"/"+action, func(t *testing.T) {
				calls := 0
				installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(context.Context, controlprotocol.CoreRelease) (io.ReadCloser, error) {
					calls++
					return nil, errors.New("must not fetch")
				}})
				if err != nil {
					t.Fatal(err)
				}
				root := t.TempDir()
				if err = os.Chmod(root, 0700); err != nil {
					t.Fatal(err)
				}
				first := testDesired(t, 1)
				r, err := Open(root, first.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer})
				if err != nil {
					t.Fatal(err)
				}
				if _, err = r.Submit(context.Background(), first); err != nil {
					t.Fatal(err)
				}
				if err = r.Close(); err != nil {
					t.Fatal(err)
				}
				var history journal
				if err = readJSON(filepath.Join(root, "state.json"), &history); err != nil {
					t.Fatal(err)
				}
				release, _ := controlprotocol.FindCoreRelease(id)
				pending := testDesired(t, 2)
				pending.Action = action
				pending.AdapterID = release.AdapterID
				pending.CoreVersion = release.Version
				pending.CoreReleaseID = id
				if action == "upgrade" {
					pending.Transition = &controlprotocol.CoreTransition{From: first.Identity(), ReleaseID: id, ExecutableSHA256: release.ExecutableSHA256}
				}
				identity := pending.Identity()
				history.Payload = &pending
				history.RequestDigest = requestDigest(pending)
				history.State.Desired = &identity
				history.State.HighestAccepted = 2
				history.State.Phase = Accepted
				history.State.NativeChecked = false
				history.Stage = ""
				if err = writeJSON(filepath.Join(root, "state.json"), history); err != nil {
					t.Fatal(err)
				}
				r, err = Open(root, first.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer})
				if err != nil {
					t.Fatal("authentic history unreadable", err)
				}
				defer r.Close()
				state, err := r.Recover(context.Background())
				if err == nil || !strings.Contains(err.Error(), "retired") || state.Code != "core_release_retired" || state.RecoveryRequired || state.Observed == nil || state.Observed.Identity != first.Identity() || calls != 0 {
					t.Fatalf("retired recovery changed live runtime or fetched: %+v err=%v downloads=%d", state, err, calls)
				}
				if _, err = r.Submit(context.Background(), pending); err == nil || !strings.Contains(err.Error(), "retired") || calls != 0 {
					t.Fatalf("retired journal replay admitted: err=%v calls=%d", err, calls)
				}
				if _, err = installer.Installed(id); err == nil {
					t.Fatal("pending recovery materialized retired binary")
				}
				if err = r.Close(); err != nil {
					t.Fatal(err)
				}
				if err = readJSON(filepath.Join(root, "state.json"), &history); err != nil {
					t.Fatal(err)
				}
				if history.RequestDigest != requestDigest(pending) || history.LastValid.Identity() != first.Identity() {
					t.Fatal("retirement corrupted historical identity")
				}
				// A one-shot CLI opens the journal and submits directly. A terminal
				// retirement must not trap its strictly newer, current replacement.
				oneShot, openErr := Open(root, first.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer})
				if openErr != nil {
					t.Fatal(openErr)
				}
				current, _ := controlprotocol.FindInstallableCoreRelease("xray-26.10.31-linux-amd64")
				replacement := testDesired(t, 3)
				replacement.Action = "install"
				replacement.AdapterID = current.AdapterID
				replacement.CoreVersion = current.Version
				replacement.CoreReleaseID = current.ID
				replaced, replacementErr := oneShot.Submit(context.Background(), replacement)
				if replacementErr == nil || errors.Is(replacementErr, controlprotocol.ErrCoreReleaseRetired) || calls != 1 || replaced.HighestAccepted != 3 || replaced.Observed == nil || replaced.Observed.Identity != first.Identity() {
					t.Fatalf("current replacement trapped behind retired recovery: %+v err=%v calls=%d", replaced, replacementErr, calls)
				}
				if err = oneShot.Close(); err != nil {
					t.Fatal(err)
				}
				history.Payload.Artifacts[0].Content = "tampered"
				if err = writeJSON(filepath.Join(root, "state.json"), history); err != nil {
					t.Fatal(err)
				}
				if reopened, err := Open(root, first.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer}); err == nil {
					reopened.Close()
					t.Fatal("tampered historical journal opened")
				}
			})
		}
	}
}

func TestNativeStockRetiredReceiptsRecoverWithoutDownload(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("exact historical stock cache not configured")
	}
	for _, id := range []string{"xray-26.3.27-linux-amd64", "sing-box-1.14.3-linux-amd64"} {
		t.Run(id, func(t *testing.T) {
			calls := 0
			installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(context.Context, controlprotocol.CoreRelease) (io.ReadCloser, error) {
				calls++
				return nil, errors.New("recovery must not download")
			}})
			if err != nil {
				t.Fatal(err)
			}
			release, _ := controlprotocol.FindCoreRelease(id)
			binary, err := os.ReadFile(filepath.Join(cache, id))
			if err != nil {
				t.Fatal(err)
			}
			if digestBytes(binary) != release.ExecutableSHA256 {
				t.Fatal("historical cache is not exact pinned bytes")
			}
			dir := filepath.Join(installer.root, id+"-"+release.ExecutableSHA256)
			if err = os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(dir, "core"), binary, 0500); err != nil {
				t.Fatal(err)
			}
			if err = writeJSON(filepath.Join(dir, "release.json"), release); err != nil {
				t.Fatal(err)
			}
			installed, err := installer.Installed(id)
			if err != nil {
				t.Fatal(err)
			}
			checker, err := NewInstalledNativeChecker(installed, 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			if err = os.Chmod(root, 0700); err != nil {
				t.Fatal(err)
			}
			d := nativeDesired(t, release.AdapterID, release.Version)
			d.Action = "install"
			d.CoreReleaseID = id
			if release.AdapterID == "routeweaver/xray" {
				d.Artifacts[0].Content = `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`
			} else {
				d.Artifacts[0].Content = `{"inbounds":[],"outbounds":[{"type":"direct","tag":"direct"}]}`
			}
			d.Digest, _ = ArtifactDigest(d.Artifacts)
			stage, err := stageFiles(root, d)
			if err != nil {
				t.Fatal(err)
			}
			if err = checker.Validate(context.Background(), Staged{Desired: d, Directory: filepath.Join(root, stage), Root: root, nativeReceipt: &nativeValidationReceipt{}}); err != nil {
				t.Fatal(err)
			}
			identity := d.Identity()
			history := journal{Schema: 1, Scope: d.Scope, Payload: &d, RequestDigest: requestDigest(d), Stage: stage, State: State{Desired: &identity, HighestAccepted: d.Generation, Phase: "installed", Code: "artifact_installed", NativeChecked: true, Installation: &controlprotocol.CoreInstallation{ReleaseID: id, AdapterID: release.AdapterID, Version: release.Version, Platform: release.Platform, ExecutableSHA256: release.ExecutableSHA256}}}
			if err = writeJSON(filepath.Join(root, "state.json"), history); err != nil {
				t.Fatal(err)
			}
			r, err := Open(root, d.Scope, NewRegistry(), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer})
			if err != nil {
				t.Fatal(err)
			}
			state, err := r.Recover(context.Background())
			if err != nil || state.Phase != "installed" || state.RecoveryRequired || state.Installation == nil || state.Installation.ReleaseID != id || calls != 0 {
				t.Fatalf("historical receipt failed recovery: %+v %v calls=%d", state, err, calls)
			}
			for generation, action := range []string{"configure", "rollback"} {
				existing := d
				existing.Action = action
				existing.Generation = uint64(generation + 2)
				existing.OperationID = action
				existing.RevisionID = action
				state, err := r.Submit(context.Background(), existing)
				if !errors.Is(err, ErrUnsupportedActivation) || !state.NativeChecked || calls != 0 {
					t.Fatalf("historical lifecycle fetched or lost parser capability: %s %+v %v calls=%d", action, state, err, calls)
				}
			}
			if err = r.Close(); err != nil {
				t.Fatal(err)
			}
			altered := release
			altered.Version = "relabeled"
			if err = writeJSON(filepath.Join(dir, "release.json"), altered); err != nil {
				t.Fatal(err)
			}
			if _, err = installer.Installed(id); err == nil {
				t.Fatal("tampered receipt accepted")
			}
			if reopened, err := Open(root, d.Scope, NewRegistry(), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer}); err == nil {
				reopened.Close()
				t.Fatal("tampered receipt loaded during recovery")
			}
			if err = writeJSON(filepath.Join(dir, "release.json"), release); err != nil {
				t.Fatal(err)
			}
			if err = os.Chmod(installed.Executable, 0700); err != nil {
				t.Fatal(err)
			}
			if err = atomicWrite(installed.Executable, []byte("tampered"), 0500); err != nil {
				t.Fatal(err)
			}
			if _, err = installer.Installed(id); err == nil {
				t.Fatal("tampered historical executable accepted")
			}
			if calls != 0 {
				t.Fatal("receipt recovery fetched bytes")
			}
		})
	}
}

func TestRetiredPendingUpgradeWithValidationOnlyAdapterIsBlocked(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	release, _ := controlprotocol.FindCoreRelease("xray-26.3.27-linux-amd64")
	d := testDesired(t, 2)
	d.Action = "upgrade"
	d.AdapterID = release.AdapterID
	d.CoreVersion = release.Version
	d.CoreReleaseID = release.ID
	prior := testDesired(t, 1)
	d.Transition = &controlprotocol.CoreTransition{From: prior.Identity(), ReleaseID: release.ID, ExecutableSHA256: release.ExecutableSHA256}
	identity := d.Identity()
	history := journal{Schema: 1, Scope: d.Scope, Payload: &d, RequestDigest: requestDigest(d), State: State{Desired: &identity, HighestAccepted: 2, Phase: Accepted}}
	if err := writeJSON(filepath.Join(root, "state.json"), history); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "unexecuted-fixture")
	if err := os.WriteFile(binary, []byte("must never execute"), 0700); err != nil {
		t.Fatal(err)
	}
	checker, err := NewNativeChecker(release.AdapterID, release.Version, binary, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	r, err := Open(root, d.Scope, NewRegistry(checker), Options{MaxLease: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	state, err := r.Recover(context.Background())
	if !errors.Is(err, controlprotocol.ErrCoreReleaseRetired) || state.Code != "core_release_retired" || state.Phase != Blocked || state.RecoveryRequired {
		t.Fatalf("pending validation-only upgrade was not retired: %+v %v", state, err)
	}
}
