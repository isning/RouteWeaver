package agent

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
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
	if _, err = installer.Prepare(context.Background(), "xray-26.3.27-linux-amd64"); err == nil {
		t.Fatal("corrupted official archive was installed")
	}
	if calls != 1 {
		t.Fatal("official archive source was not used")
	}
}

func TestNativeCoreInstallerPreparesImmutableOfficialExecutables(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not configured")
	}
	for _, release := range controlprotocol.OfficialCoreReleases() {
		t.Run(release.ID, func(t *testing.T) {
			calls := 0
			installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(_ context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
				calls++
				name := strings.TrimPrefix(r.AdapterID, "routeweaver/")
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
			if err = os.WriteFile(prepared.Executable, []byte("corruption"), 0500); err != nil {
				t.Fatal(err)
			}
			if _, err = installer.Prepare(context.Background(), release.ID); err == nil {
				t.Fatal("changed immutable binary was reused")
			}
		})
	}
}

func TestNativeInstallDesiredPreservesActiveRuntimeAndLease(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not configured")
	}
	installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(_ context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
		return os.Open(filepath.Join(cache, strings.TrimPrefix(r.AdapterID, "routeweaver/")+".download"))
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
	install.CoreVersion = "26.3.27"
	install.CoreReleaseID = "xray-26.3.27-linux-amd64"
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
	cache := os.Getenv("ROUTEWEAVER_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not configured")
	}
	installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(_ context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
		return os.Open(filepath.Join(cache, strings.TrimPrefix(r.AdapterID, "routeweaver/")+".download"))
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
	install.CoreVersion = "26.3.27"
	install.CoreReleaseID = "xray-26.3.27-linux-amd64"
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
	if _, err = installer.Prepare(context.Background(), "xray-26.3.27-linux-amd64"); err == nil || calls != 0 {
		t.Fatal("replaced core root was followed or fetched")
	}
}

func TestNativeInstallDownloadCannotDelayActiveLeaseExpiry(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not configured")
	}
	fetching := make(chan struct{})
	releaseFetch := make(chan struct{})
	installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(ctx context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
		close(fetching)
		select {
		case <-releaseFetch:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return os.Open(filepath.Join(cache, "xray.download"))
	}})
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	os.Chmod(root, 0700)
	runtime := LocalFixture{}
	r, err := Open(root, testDesired(t, 1).Scope, NewRegistry(runtime), Options{MaxLease: 2 * time.Hour, CoreInstaller: installer})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	first := testDesired(t, 1)
	first.Lease.ExpiresAt = time.Now().Add(80 * time.Millisecond)
	if _, err = r.Submit(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	install := testDesired(t, 2)
	install.Action = "install"
	install.AdapterID = "routeweaver/xray"
	install.CoreVersion = "26.3.27"
	install.CoreReleaseID = "xray-26.3.27-linux-amd64"
	install.Artifacts[0].Content = `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`
	install.Digest, _ = ArtifactDigest(install.Artifacts)
	done := make(chan error, 1)
	go func() { _, err := r.Submit(context.Background(), install); done <- err }()
	<-fetching
	deadline := time.Now().Add(300 * time.Millisecond)
	expired := false
	for time.Now().Before(deadline) {
		observation, err := runtime.Observe(context.Background(), root)
		if err == nil && observation.Generation == 0 {
			expired = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(releaseFetch)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if !expired {
		t.Fatal("slow archive retrieval kept old runtime alive beyond its original lease")
	}
}

func TestNativeInstallDoesNotMutateAnotherInstancesRegistry(t *testing.T) {
	cache := os.Getenv("ROUTEWEAVER_CORE_BIN_DIR")
	if cache == "" {
		t.Skip("official archive cache not configured")
	}
	installer, err := NewCoreInstaller(filepath.Join(t.TempDir(), "cores"), CoreInstallerOptions{OpenArchive: func(_ context.Context, r controlprotocol.CoreRelease) (io.ReadCloser, error) {
		return os.Open(filepath.Join(cache, "xray.download"))
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
	install.CoreVersion = "26.3.27"
	install.CoreReleaseID = "xray-26.3.27-linux-amd64"
	install.Artifacts[0].Content = `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`
	install.Digest, _ = ArtifactDigest(install.Artifacts)
	if _, err = r.Submit(context.Background(), install); err != nil {
		t.Fatal(err)
	}
	if _, err = shared.Get(install.AdapterID, install.CoreVersion); err == nil {
		t.Fatal("one instance changed the caller's shared runtime registry")
	}
}
