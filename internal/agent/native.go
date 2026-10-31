package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// NativeCommandSpec is trusted local adapter code, never a control-plane shell
// command. Version, validation and foreground launch behavior vary by adapter.
type ProcessIO struct {
	ExtraFiles []*os.File
	AfterStart func()
	OnExit     func()
}
type NativeCommandSpec struct {
	PrepareProcess func(Staged) (*ProcessIO, error)

	VersionArgs  []string
	MatchVersion func(string, string) bool
	ValidateArgs func(Staged) []string
	RunArgs      func(Staged) []string
	// Environment is trusted adapter code for staged resource roots, never
	// remote-supplied environment or inherited control-plane credentials.
	Environment func(Staged) []string
}
type nativeRegistration struct {
	source   string
	commands NativeCommandSpec
}

func configPath(s Staged) string {
	return filepath.Join(s.Directory, filepath.FromSlash(s.Desired.EntryFile))
}

var nativeRegistrations = map[string]nativeRegistration{
	"routeweaver/xray@26.3.27": {source: "https://github.com/XTLS/Xray-core/blob/v26.3.27/main/run.go", commands: NativeCommandSpec{
		Environment: xrayStagedEnvironment,
		VersionArgs: []string{"version"}, MatchVersion: func(out, version string) bool {
			words := strings.Fields(out)
			return len(words) >= 2 && words[0] == "Xray" && words[1] == version
		},
		ValidateArgs: func(s Staged) []string { return []string{"run", "-test", "-format", "json", "-config", configPath(s)} }, RunArgs: func(s Staged) []string { return []string{"run", "-format", "json", "-config", configPath(s)} },
	}},
	"routeweaver/sing-box@1.14.3": {source: "https://github.com/SagerNet/sing-box/blob/v1.14.3/cmd/sing-box/cmd_check.go", commands: NativeCommandSpec{
		VersionArgs: []string{"version", "-n"}, MatchVersion: func(out, version string) bool { return strings.TrimSpace(out) == version },
		ValidateArgs: func(s Staged) []string { return []string{"check", "-c", configPath(s)} }, RunArgs: func(s Staged) []string { return []string{"run", "-c", configPath(s)} },
	}},
}

// NativeChecker validates only. A ProcessSupervisor separately opts in to
// foreground child-process ownership; neither result proves a live route.
type NativeChecker struct {
	descriptor       Descriptor
	binary           string
	executableSHA256 string
	timeout          time.Duration
	commands         NativeCommandSpec
}

func NewNativeChecker(id, version, binary string, timeout time.Duration) (*NativeChecker, error) {
	registration, ok := nativeRegistrations[id+"@"+version]
	if !ok {
		return nil, errors.New("native checker version has not been source verified")
	}
	return NewCommandChecker(Descriptor{ID: id, Version: version, NativeValidation: true, Evidence: "native_check_only", Source: registration.source}, binary, timeout, registration.commands)
}

// NewCommandChecker is an extension seam for a locally installed, independently
// reviewed adapter. It accepts no remote command strings and never invokes a shell.
func NewCommandChecker(d Descriptor, binary string, timeout time.Duration, c NativeCommandSpec) (*NativeChecker, error) {
	if !adapterPattern.MatchString(d.ID) || d.Version == "" || !d.NativeValidation || d.CanActivate || d.Source == "" || !filepath.IsAbs(binary) || timeout <= 0 || timeout > time.Minute {
		return nil, errors.New("valid checker descriptor, absolute binary and timeout (0,1m] required")
	}
	if len(c.VersionArgs) == 0 || c.MatchVersion == nil || c.ValidateArgs == nil || c.RunArgs == nil {
		return nil, errors.New("complete native command descriptor required")
	}
	c.VersionArgs = append([]string(nil), c.VersionArgs...)
	return &NativeChecker{descriptor: d, binary: binary, timeout: timeout, commands: c}, nil
}
func (n *NativeChecker) Descriptor() Descriptor { return n.descriptor }
func (n *NativeChecker) Validate(ctx context.Context, s Staged) error {
	var receiptPath, receiptDigest string
	if s.nativeReceipt != nil {
		var err error
		receiptPath, err = filepath.EvalSymlinks(n.binary)
		if err != nil {
			return err
		}
		receiptDigest, err = executableDigest(receiptPath)
		if err != nil {
			return err
		}
	}
	if n.executableSHA256 != "" {
		if err := verifyExecutableDigest(n.binary, n.executableSHA256); err != nil {
			return err
		}
	}
	if s.Desired.AdapterID != n.descriptor.ID || s.Desired.CoreVersion != n.descriptor.Version {
		return errors.New("native checker target mismatch")
	}
	out, err := runBounded(ctx, n.binary, n.commands.VersionArgs, s.Directory, n.timeout, 4096, n.stagedEnvironment(s)...)
	if err != nil {
		return phaseError("core_version_check_failed")
	}
	if !n.commands.MatchVersion(out, n.descriptor.Version) {
		return phaseError("core_version_mismatch")
	}
	if _, err = runBounded(ctx, n.binary, n.commands.ValidateArgs(s), s.Directory, n.timeout, 64<<10, n.stagedEnvironment(s)...); err != nil {
		return phaseError("native_config_check_failed")
	}
	if s.nativeReceipt != nil {
		if err = verifyExecutableDigest(receiptPath, receiptDigest); err != nil {
			return err
		}
		*s.nativeReceipt = nativeValidationReceipt{checker: n, identity: s.Desired.Identity(), directory: s.Directory, binaryPath: receiptPath, binarySHA256: receiptDigest}
	}
	return nil
}
func (n *NativeChecker) Activate(context.Context, Staged) error { return ErrUnsupportedActivation }
func (n *NativeChecker) Observe(context.Context, string) (Observation, error) {
	return Observation{Evidence: "native_observation_unverified"}, ErrUnknownRuntime
}

func (n *NativeChecker) stagedEnvironment(s Staged) []string {
	if n.commands.Environment == nil {
		return nil
	}
	return n.commands.Environment(s)
}
func xrayStagedEnvironment(s Staged) []string {
	// Pinned upstream resolves relative certificates against LOCATION_CERT,
	// not cwd. Bind both resource roots to the verified revision artifact tree.
	return []string{"XRAY_LOCATION_CERT=" + s.Directory, "XRAY_LOCATION_ASSET=" + s.Directory}
}

// A receipt is private to a single staged reconciliation. It binds both checked
// inputs and exact executable bytes, and cannot be supplied over the wire.
type nativeValidationReceipt struct {
	checker                             *NativeChecker
	identity                            Identity
	directory, binaryPath, binarySHA256 string
}

func (n *NativeChecker) verifyReceipt(st Staged) error {
	p := st.nativeReceipt
	if p == nil || p.checker != n || p.identity != st.Desired.Identity() || p.directory != st.Directory {
		return errors.New("native validation receipt missing or mismatched")
	}
	binary, err := filepath.EvalSymlinks(n.binary)
	if err != nil || binary != p.binaryPath {
		return errors.New("validated executable path changed")
	}
	if err = verifyExecutableDigest(binary, p.binarySHA256); err != nil {
		return err
	}
	stage, err := filepath.Rel(st.Root, st.Directory)
	if err != nil {
		return err
	}
	return verifyStage(st.Root, stage, st.Desired)
}
func (s *ProcessSupervisor) verifyPreparedActivation(st Staged) error {
	return s.checker.verifyReceipt(st)
}
