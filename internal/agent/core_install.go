package agent

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/resources"
)

const maxCoreArchiveBytes int64 = 128 << 20

// CoreInstallerOptions contains trusted local integration only. OpenArchive can
// provide an offline release cache, but cannot change the catalog or its hashes.
// Nothing in Desired can select a URL, path, command, or fetch implementation.
type CoreInstallerOptions struct {
	OpenArchive func(context.Context, controlprotocol.CoreRelease) (io.ReadCloser, error)
}
type InstalledCore struct {
	Release    controlprotocol.CoreRelease `json:"release"`
	Executable string                      `json:"executable"`
}
type CoreInstaller struct {
	root        string
	openArchive func(context.Context, controlprotocol.CoreRelease) (io.ReadCloser, error)
}

func NewCoreInstaller(root string, options CoreInstallerOptions) (*CoreInstaller, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(absolute, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("core installation root must be a private real directory")
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil || resolved != absolute {
		return nil, errors.New("core installation root must not contain symlinks")
	}
	if options.OpenArchive == nil {
		options.OpenArchive = openOfficialCoreArchive
	}
	return &CoreInstaller{root: absolute, openArchive: options.OpenArchive}, nil
}

// Prepare checks catalog/platform and both hashes before publishing an immutable
// executable. It never starts a service or replaces an existing release path.
func (i *CoreInstaller) Prepare(ctx context.Context, releaseID string) (InstalledCore, error) {
	release, err := controlprotocol.FindInstallableCoreRelease(releaseID)
	if err != nil {
		return InstalledCore{}, err
	}
	if release.Platform != runtime.GOOS+"-"+runtime.GOARCH {
		return InstalledCore{}, fmt.Errorf("release %s supports %s, not %s-%s; choose a reviewed platform release", release.ID, release.Platform, runtime.GOOS, runtime.GOARCH)
	}
	if err = i.verifyRoot(); err != nil {
		return InstalledCore{}, err
	}
	lock, err := lockRoot(i.root)
	if err != nil {
		return InstalledCore{}, err
	}
	defer unlockRoot(lock)
	destination := filepath.Join(i.root, release.ID+"-"+release.ExecutableSHA256)
	installed := InstalledCore{Release: release, Executable: filepath.Join(destination, "core")}
	if _, err = os.Lstat(destination); err == nil {
		return i.verifyInstalled(installed)
	} else if !errors.Is(err, os.ErrNotExist) {
		return InstalledCore{}, err
	}
	input, err := i.openArchive(ctx, release)
	if err != nil {
		return InstalledCore{}, errors.New("official core archive unavailable; check connectivity or provide a verified offline release cache")
	}
	defer input.Close()
	data, err := io.ReadAll(io.LimitReader(input, maxCoreArchiveBytes+1))
	if err != nil || int64(len(data)) > maxCoreArchiveBytes {
		return InstalledCore{}, errors.New("core archive exceeds limit or could not be read")
	}
	if err = ctx.Err(); err != nil {
		return InstalledCore{}, err
	}
	executable, err := VerifyCoreArchive(data, release)
	if err != nil {
		return InstalledCore{}, err
	}
	temporary, err := os.MkdirTemp(i.root, ".prepare-")
	if err != nil {
		return InstalledCore{}, err
	}
	defer os.RemoveAll(temporary)
	if err = atomicWrite(filepath.Join(temporary, "core"), executable, 0500); err != nil {
		return InstalledCore{}, err
	}
	checker, err := NewNativeChecker(release.AdapterID, release.Version, filepath.Join(temporary, "core"), 10*time.Second)
	if err != nil {
		return InstalledCore{}, err
	}
	version, err := runBounded(ctx, checker.binary, checker.commands.VersionArgs, temporary, 10*time.Second, 4096)
	if err != nil || !checker.commands.MatchVersion(version, release.Version) {
		return InstalledCore{}, errors.New("official core executable does not report the reviewed version")
	}
	if err = writeJSON(filepath.Join(temporary, "release.json"), release); err != nil {
		return InstalledCore{}, err
	}
	if err = syncDir(temporary); err != nil {
		return InstalledCore{}, err
	}
	if err = ctx.Err(); err != nil {
		return InstalledCore{}, err
	}
	if err = os.Rename(temporary, destination); err != nil {
		return InstalledCore{}, err
	}
	if err = syncDir(i.root); err != nil {
		return InstalledCore{}, err
	}
	return i.verifyInstalled(installed)
}
func (i *CoreInstaller) verifyInstalled(installed InstalledCore) (InstalledCore, error) {
	if err := i.verifyRoot(); err != nil {
		return InstalledCore{}, err
	}
	directory := filepath.Dir(installed.Executable)
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return InstalledCore{}, errors.New("immutable core directory changed")
	}
	manifest, err := os.Lstat(filepath.Join(directory, "release.json"))
	if err != nil || !manifest.Mode().IsRegular() || manifest.Mode().Perm()&0077 != 0 {
		return InstalledCore{}, errors.New("immutable core release manifest is not a private regular file")
	}
	var recorded controlprotocol.CoreRelease
	if err = readJSON(filepath.Join(directory, "release.json"), &recorded); err != nil || recorded != installed.Release {
		return InstalledCore{}, errors.New("immutable core release manifest changed")
	}
	if err = verifyExecutableDigest(installed.Executable, installed.Release.ExecutableSHA256); err != nil {
		return InstalledCore{}, err
	}
	return installed, nil
}
func digestBytes(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func verifyExecutableDigest(filename, expected string) error {
	actual, err := executableDigest(filename)
	if err != nil {
		return err
	}
	if actual != expected {
		return errors.New("immutable core executable checksum mismatch")
	}
	return nil
}
func executableDigest(filename string) (string, error) {
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Size() > 128<<20 {
		return "", errors.New("immutable core executable is missing, unsafe or changed")
	}
	f, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, io.LimitReader(f, 128<<20+1)); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func openOfficialCoreArchive(ctx context.Context, release controlprotocol.CoreRelease) (io.ReadCloser, error) {
	transport := &http.Transport{DialContext: resources.PublicDialer(), Proxy: nil, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, ResponseHeaderTimeout: 15 * time.Second, MaxResponseHeaderBytes: 32 << 10}
	client := &http.Client{Timeout: 3 * time.Minute, Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 || !officialAssetURL(req.URL) {
			return errors.New("unapproved official release redirect")
		}
		return nil
	}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, release.URL, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, err
	}
	if response.StatusCode != http.StatusOK || response.ContentLength > maxCoreArchiveBytes {
		response.Body.Close()
		transport.CloseIdleConnections()
		return nil, errors.New("official release download failed or is too large")
	}
	return &coreDownload{ReadCloser: response.Body, transport: transport}, nil
}

type coreDownload struct {
	io.ReadCloser
	transport *http.Transport
}

func (d *coreDownload) Close() error {
	err := d.ReadCloser.Close()
	d.transport.CloseIdleConnections()
	return err
}
func officialAssetURL(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	switch u.Hostname() {
	case "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
		return true
	}
	return false
}

// NewInstalledNativeChecker keeps the executable pin active on every validation,
// including the supervisor's final validation immediately before replacement.
func NewInstalledNativeChecker(installed InstalledCore, timeout time.Duration) (*NativeChecker, error) {
	release, err := controlprotocol.FindCoreRelease(installed.Release.ID)
	if err != nil || release != installed.Release {
		return nil, errors.New("installed core is not an exact official catalog release")
	}
	if err = verifyExecutableDigest(installed.Executable, release.ExecutableSHA256); err != nil {
		return nil, err
	}
	checker, err := NewNativeChecker(release.AdapterID, release.Version, installed.Executable, timeout)
	if err != nil {
		return nil, err
	}
	checker.executableSHA256 = release.ExecutableSHA256
	return checker, nil
}

// Installed only verifies already prepared bytes. Recovery never downloads or
// invokes a new installation implicitly.
func (i *CoreInstaller) Installed(releaseID string) (InstalledCore, error) {
	release, err := controlprotocol.FindCoreRelease(releaseID)
	if err != nil {
		return InstalledCore{}, err
	}
	return i.verifyInstalled(InstalledCore{Release: release, Executable: filepath.Join(i.root, release.ID+"-"+release.ExecutableSHA256, "core")})
}
func (r *Reconciler) installedAdapterLocked(installed InstalledCore, activate bool) (Adapter, error) {
	checker, err := NewInstalledNativeChecker(installed, 10*time.Second)
	if err != nil {
		return nil, err
	}
	var adapter Adapter = checker
	if activate && r.options.InstallSupervisor != nil {
		adapter, err = NewProcessSupervisor(checker, *r.options.InstallSupervisor)
		if err != nil {
			return nil, err
		}
	}
	if !activate {
		if _, lookupErr := r.registry.Get(installed.Release.AdapterID, installed.Release.Version); lookupErr != nil {
			if _, registerErr := r.installedAdapterLocked(installed, true); registerErr != nil {
				return nil, registerErr
			}
		}
		return adapter, nil
	}
	if existing, e := r.registry.Get(installed.Release.AdapterID, installed.Release.Version); e == nil {
		binary, ok := existing.(interface{ immutableExecutable() string })
		if !ok || binary.immutableExecutable() != installed.Executable {
			return nil, errors.New("target adapter is already registered with another executable; restart with the prepared immutable release path")
		}
	}
	r.registry.replacePrepared(adapter)
	return adapter, nil
}
func (n *NativeChecker) immutableExecutable() string     { return n.binary }
func (s *ProcessSupervisor) immutableExecutable() string { return s.checker.binary }

func (r *Reconciler) completedInstallation() bool {
	s := r.disk.State
	return r.disk.Payload != nil && r.disk.Payload.Action == "install" && s.Phase == "installed" && s.Code == "artifact_installed" && s.NativeChecked && s.Installation != nil
}

func (r *Reconciler) recoverInstallationLocked(ctx context.Context) (State, error) {
	if r.options.CoreInstaller == nil {
		return r.fail(Unknown, "core_installation_store_unavailable", ErrUnknownRuntime)
	}
	completed := r.disk.State.Phase == "installed"
	if completed {
		installed, err := r.options.CoreInstaller.Installed(r.disk.Payload.CoreReleaseID)
		if err != nil {
			return r.fail(Unknown, "installed_core_drift", err)
		}
		if r.disk.State.Installation == nil || r.disk.State.Installation.ExecutableSHA256 != installed.Release.ExecutableSHA256 {
			return r.fail(Unknown, "installed_core_evidence_missing", ErrUnknownRuntime)
		}
		if err = verifyStage(r.root, r.disk.Stage, *r.disk.Payload); err != nil {
			return r.fail(Unknown, "installed_config_drift", err)
		}
	}
	if r.disk.LastValid != nil {
		old, err := r.registry.Get(r.disk.LastValid.AdapterID, r.disk.LastValid.CoreVersion)
		if err != nil {
			return r.fail(Unknown, "active_adapter_missing", err)
		}
		observed, err := old.Observe(ctx, r.root)
		if err != nil || !observed.Known || !observed.Quiescent || (observed.Generation != 0 && observed.Identity != r.disk.LastValid.Identity()) {
			return r.fail(Unknown, "active_runtime_observation_unknown", ErrUnknownRuntime)
		}
		if observed.Generation != 0 {
			r.disk.State.Observed = &observed
		} else {
			r.disk.State.Observed = nil
		}
		if err = r.gate(r.effectivePolicy()); err != nil {
			return r.restrictLocked(ctx)
		}
	}
	r.disk.State.RecoveryRequired = false
	if !completed {
		if _, err := controlprotocol.FindInstallableCoreRelease(r.disk.Payload.CoreReleaseID); err != nil {
			return r.fail(Blocked, "core_release_retired", err)
		}
	}
	if completed {
		r.disk.State.Phase = "installed"
		r.disk.State.Code = "artifact_installed"
	}
	return r.out(r.persist())
}

func (r *Reconciler) loadInstalledAdapters() error {
	if r.options.CoreInstaller == nil {
		return nil
	}
	for _, release := range controlprotocol.OfficialCoreReleases() {
		path := filepath.Join(r.options.CoreInstaller.root, release.ID+"-"+release.ExecutableSHA256)
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		installed, err := r.options.CoreInstaller.Installed(release.ID)
		if err != nil {
			return err
		}
		if _, err = r.registry.Get(release.AdapterID, release.Version); err != nil {
			if _, err = r.installedAdapterLocked(installed, true); err != nil {
				return err
			}
		}
	}
	return nil
}

func (i *CoreInstaller) verifyRoot() error {
	info, err := os.Lstat(i.root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return errors.New("core installation root is missing, unsafe or replaced")
	}
	resolved, err := filepath.EvalSymlinks(i.root)
	if err != nil || resolved != i.root {
		return errors.New("core installation root contains a symlink")
	}
	return nil
}

// Downloads and checksum/extraction work cannot borrow the old runtime's lease.
// The generation mutation lane remains reserved, while its owner evaluates and
// enforces policy independently of a slow archive source. No process is launched
// by the worker, and Prepare checks cancellation before publishing a release.
func (r *Reconciler) prepareCoreLocked(ctx context.Context, releaseID string) (InstalledCore, error) {
	var installed InstalledCore
	err := r.awaitPreparationLocked(ctx, func(ctx context.Context) error {
		var err error
		// Admission already rejects retired install/upgrade intent. Other lifecycle
		// actions may recover an existing historical receipt, never fetch it anew.
		if _, activeErr := controlprotocol.FindInstallableCoreRelease(releaseID); activeErr != nil {
			installed, err = r.options.CoreInstaller.Installed(releaseID)
		} else {
			installed, err = r.options.CoreInstaller.Prepare(ctx, releaseID)
		}
		return err
	})
	if err != nil {
		return InstalledCore{}, err
	}
	return installed, nil
}

// Validation and immutable preparation have no runtime activation side effects.
// Keep their work outside the reserved lane's policy-timer execution so old
// leases cannot be extended by downloads, checksums, or native parser delays.
func (r *Reconciler) awaitPreparationLocked(ctx context.Context, work func(context.Context) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- work(ctx) }()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	restricted := false
	enforce := func() error {
		if !restricted && r.disk.LastValid != nil && r.gate(r.effectivePolicy()) != nil {
			_, err := r.restrictLocked(ctx)
			if !errors.Is(err, ErrLeaseBlocked) {
				return err
			}
			restricted = true
		}
		return nil
	}
	for {
		select {
		case err := <-done:
			if policyErr := enforce(); policyErr != nil {
				return policyErr
			}
			return err
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := enforce(); err != nil {
				return err
			}
		}
	}
}
