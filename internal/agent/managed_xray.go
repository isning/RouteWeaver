package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
)

const ManagedXrayID = "routeweaver/managed-xray"
const ManagedXrayVersion = "26.3.27-rw1"

func ManagedAdmissionSocket(root string) string  { return filepath.Join(root, "admission.sock") }
func ManagedControlSocket(root string) string    { return filepath.Join(root, "managed.sock") }
func ManagedJournalDirectory(root string) string { return filepath.Join(root, "managed-counters") }
func init() {
	nativeRegistrations[ManagedXrayID+"@"+ManagedXrayVersion] = nativeRegistration{source: "https://github.com/XTLS/Xray-core/tree/v26.3.27", commands: NativeCommandSpec{
		PrepareProcess: prepareManagedPipes,
		Environment:    xrayStagedEnvironment,
		VersionArgs:    []string{"version"}, MatchVersion: func(out, version string) bool {
			return strings.TrimSpace(out) == "RouteWeaver managed-xray "+version+" Xray 26.3.27"
		},
		ValidateArgs: func(s Staged) []string {
			return []string{"check", "--config", configPath(s), "--policy", filepath.Join(s.Directory, "entry-policy.json")}
		},
		RunArgs: func(s Staged) []string {
			return []string{"run", "--config", configPath(s), "--policy", filepath.Join(s.Directory, "entry-policy.json"), "--ipc", "pipes", "--journal-dir", ManagedJournalDirectory(s.Root)}
		},
	}}
}
func NewManagedXrayChecker(binary string, timeout time.Duration) (*NativeChecker, error) {
	return NewNativeChecker(ManagedXrayID, ManagedXrayVersion, binary, timeout)
}

// Acquire and Release implement the only CP operations the private broker offers
// to a managed core. Enrollment credentials remain inside HTTPTransport.
func (t *HTTPTransport) Acquire(ctx context.Context, r entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	var out entrypolicy.Lease
	if !domain.ValidID(r.EntryID) || !domain.ValidID(r.SubjectID) || !domain.ValidID(r.CredentialVersion) || !domain.ValidID(r.PresenceID) {
		return out, errors.New("invalid admission request identity")
	}
	b, _, err := t.request(ctx, http.MethodPost, t.endpoint("/admission-leases"), r)
	if err != nil {
		return out, err
	}
	if err = decodeWire(b, &out); err != nil {
		return out, err
	}
	return out, nil
}
func (t *HTTPTransport) Release(ctx context.Context, id string) error {
	if !domain.ValidID(id) {
		return errors.New("invalid admission lease identity")
	}
	_, _, err := t.request(ctx, http.MethodDelete, t.endpoint("/admission-leases/")+url.PathEscape(id), nil)
	return err
}

// ReadManagedJournal reads the actual retained baseline/final snapshots. It
// never manufactures a zero baseline for an already-running native counter.
func ReadManagedJournal(root string) ([]entrypolicy.Snapshot, error) {
	entries, err := os.ReadDir(ManagedJournalDirectory(root))
	if err != nil {
		return nil, err
	}
	out := []entrypolicy.Snapshot{}
	for _, e := range entries {
		if e.IsDir() || (!strings.HasSuffix(e.Name(), ".baseline.json") && !strings.HasSuffix(e.Name(), ".final.json")) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(ManagedJournalDirectory(root), e.Name()))
		if err != nil {
			return nil, err
		}
		if len(b) > 4<<20 {
			return nil, errors.New("managed snapshot too large")
		}
		var s entrypolicy.Snapshot
		if err = json.Unmarshal(b, &s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}
