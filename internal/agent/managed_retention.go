package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"routeweaver/internal/entrypolicy"
)

// One bounded retirement intent bridges the two durable stores. Journal files
// must disappear durably BEFORE deduplication cursors can disappear. No growing
// list of tombstones is needed for the runtime's fresh random epoch contract.
type managedRetirement struct {
	Scope          Scope           `json:"scope"`
	Custody        terminalCustody `json:"custody"`
	Epoch          string          `json:"epoch"`
	Directory      string          `json:"directory"`
	Acked          uint64          `json:"acked,string"`
	BaselineDigest string          `json:"baselineDigest"`
	FinalDigest    string          `json:"finalDigest"`
	Keys           []string        `json:"keys"`
}

var journalEpoch = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func meterSourceKey(c entrypolicy.Counter) string {
	return c.CounterEpoch + "\x00" + c.SubjectID + "\x00" + c.RouteID + "\x00" + c.MeasurementLayer
}
func readRetirementFile(dir *os.Root, name string) ([]byte, error) {
	info, err := dir.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4<<20 {
		return nil, errors.New("private regular managed journal required")
	}
	f, err := dir.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, (4<<20)+1))
}
func journalDigest(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }
func runningEpoch(dir *os.Root) (string, error) {
	raw, err := readRetirementFile(dir, "running.json")
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var marker struct {
		CounterEpoch string `json:"counterEpoch"`
	}
	if err = json.Unmarshal(raw, &marker); err != nil || !journalEpoch.MatchString(marker.CounterEpoch) {
		return "", errors.New("managed running marker invalid; retirement blocked")
	}
	return marker.CounterEpoch, nil
}
func decodeRetirementSnapshot(raw []byte, epoch string) (entrypolicy.Snapshot, error) {
	var s entrypolicy.Snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		return s, err
	}
	if s.CounterEpoch != epoch || s.AdapterID != ManagedXrayID || s.RuntimeVersion != ManagedXrayVersion || s.LedgerMode != "admission-budget" || s.ObservedAt.IsZero() || len(s.Counters) == 0 || len(s.Counters) > 1000 || s.ActiveFlows != 0 {
		return s, errors.New("invalid closed managed journal")
	}
	return s, nil
}

// compactManagedJournal requires explicit CP custody of the exact closed proof,
// not merely an ACK of equal live bytes. It never settles admission reservations;
// unresolved per-flow obligations remain authoritative at the control plane.
func (s *MeterSpool) compactManagedJournal(ctx context.Context, root string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("meter spool closed")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	var intent *managedRetirement
	wal := filepath.Join(s.root, "managed-retirement.json")
	if info, err := os.Lstat(wal); err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 1<<20 {
			return errors.New("invalid bounded retirement journal")
		}
		intent = &managedRetirement{}
		if err = readJSON(wal, intent); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	path, err := filepath.Abs(ManagedJournalDirectory(root))
	if err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) && intent == nil {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return errors.New("private managed journal directory required")
	}
	dir, err := os.OpenRoot(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err = s.resumeManagedRetirement(ctx, dir, intent); err != nil {
		return err
	}
	running, err := runningEpoch(dir)
	if err != nil {
		return err
	}
	f, err := dir.Open(".")
	if err != nil {
		return err
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !strings.HasSuffix(entry.Name(), ".final.json") {
			continue
		}
		epoch := strings.TrimSuffix(entry.Name(), ".final.json")
		if !journalEpoch.MatchString(epoch) {
			return errors.New("invalid managed journal epoch")
		}
		if epoch == running {
			continue
		}
		baseRaw, err := readRetirementFile(dir, epoch+".baseline.json")
		if err != nil {
			return err
		}
		finalRaw, err := readRetirementFile(dir, epoch+".final.json")
		if err != nil {
			return err
		}
		baseline, err := decodeRetirementSnapshot(baseRaw, epoch)
		if err != nil {
			return err
		}
		final, err := decodeRetirementSnapshot(finalRaw, epoch)
		if err != nil {
			return err
		}
		if final.ObservedAt.Before(baseline.ObservedAt) || len(baseline.Counters) != len(final.Counters) {
			return errors.New("managed final does not match baseline")
		}
		counters := map[string]entrypolicy.Counter{}
		for _, c := range baseline.Counters {
			key := meterSourceKey(c)
			if _, exists := counters[key]; exists || !strings.HasPrefix(c.CounterEpoch, epoch+"-") || c.SubjectID == "" || c.RouteID == "" || c.MeasurementLayer != entrypolicy.MeasurementLayer || c.CumulativeBytes != 0 || c.UploadBytes != 0 || c.DownloadBytes != 0 {
				return errors.New("invalid managed retirement baseline")
			}
			counters[key] = c
		}
		keys := make([]string, 0, len(counters))
		ready := true
		for _, c := range final.Counters {
			key := meterSourceKey(c)
			b, exists := counters[key]
			if !exists || b.Binding != c.Binding || c.MeasurementLayer != entrypolicy.MeasurementLayer || c.CumulativeBytes < c.UploadBytes || c.CumulativeBytes-c.UploadBytes != c.DownloadBytes {
				return errors.New("managed final binding mismatch")
			}
			delete(counters, key)
			keys = append(keys, key)
			cursor, exists := s.disk.ManagedSources[key]
			if !exists || cursor.Value != c.CumulativeBytes || cursor.ObservedAt.After(final.ObservedAt) {
				ready = false
			}
		}
		if !ready {
			continue
		}
		keySet := map[string]bool{}
		for _, key := range keys {
			keySet[key] = true
		}
		for _, batch := range s.disk.Pending {
			for _, sample := range batch.Samples {
				if keySet[sample.CounterEpoch+"\x00"+sample.SubjectID+"\x00"+sample.RouteID+"\x00"+sample.MeasurementLayer] {
					ready = false
				}
			}
		}
		if !ready {
			continue
		}
		custody, accepted, err := s.ensureTerminalCustodyLocked(baseline, final)
		if err != nil {
			return err
		}
		if !accepted {
			continue
		}
		sort.Strings(keys)
		intent = &managedRetirement{Scope: s.disk.Scope, Custody: custody, Epoch: epoch, Directory: path, Acked: s.disk.Acked, BaselineDigest: journalDigest(baseRaw), FinalDigest: journalDigest(finalRaw), Keys: keys}
		raw, err := json.Marshal(intent)
		if err != nil {
			return err
		}
		if len(raw) > 1<<20 {
			return errors.New("retirement journal bounds exceeded")
		}
		if err = atomicWrite(wal, raw, 0600); err != nil {
			return err
		}
		if err = s.resumeManagedRetirement(ctx, dir, intent); err != nil {
			return err
		}
	}
	return nil
}
func (s *MeterSpool) persistRetirement(next meterDisk) error {
	raw, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if len(raw) > 8<<20 {
		return errors.New("meter outbox byte bound exceeded; retirement must backpressure")
	}
	if err = atomicWrite(filepath.Join(s.root, "meter.json"), raw, 0600); err != nil {
		return err
	}
	s.disk = next
	return nil
}
func (s *MeterSpool) resumeManagedRetirement(ctx context.Context, dir *os.Root, intent *managedRetirement) error {
	if intent == nil {
		return nil
	}
	if intent.Scope != s.disk.Scope || intent.Custody.Receipt.CustodyVersion != entrypolicy.TerminalCustodyVersion || !validTerminalDigest(intent.Custody.EvidenceDigest) || intent.Custody.EvidenceDigest != intent.Custody.Receipt.TerminalEvidenceDigest || intent.Custody.Receipt.StreamEpoch != s.disk.Epoch || intent.Custody.Receipt.Sequence == 0 || !validTerminalDigest(intent.Custody.Receipt.Digest) || intent.Custody.Receipt.Sequence > intent.Acked {
		return errors.New("retirement lacks scoped terminal custody; legacy recovery requires review")
	}
	if intent.Directory != dir.Name() || intent.Acked > s.disk.Acked {
		return errors.New("managed retirement scope or receipt mismatch")
	}
	if !journalEpoch.MatchString(intent.Epoch) || len(intent.Keys) == 0 || len(intent.Keys) > 1000 || !validTerminalDigest(intent.BaselineDigest) || !validTerminalDigest(intent.FinalDigest) {
		return errors.New("invalid managed retirement intent")
	}
	// A WAL is not itself permission to invent a receipt. The map may be
	// absent only after both files AND source cursors were durably retired.
	if custody, exists := s.disk.TerminalCustody[intent.Epoch]; exists {
		if custody != intent.Custody {
			return errors.New("retirement custody differs from durable ACK")
		}
	} else {
		for _, key := range intent.Keys {
			if _, exists := s.disk.ManagedSources[key]; exists {
				return errors.New("retirement missing durable custody ACK")
			}
		}
		for _, kind := range []string{"baseline", "final"} {
			if _, err := readRetirementFile(dir, intent.Epoch+"."+kind+".json"); !errors.Is(err, os.ErrNotExist) {
				return errors.New("retirement missing custody while evidence remains")
			}
		}
	}
	for _, key := range intent.Keys {
		if !strings.HasPrefix(key, intent.Epoch+"-") {
			return errors.New("managed retirement cursor epoch mismatch")
		}
	}
	retiring := make(map[string]bool, len(intent.Keys))
	for _, key := range intent.Keys {
		retiring[key] = true
	}
	for _, batch := range s.disk.Pending {
		if batch.TerminalEvidence != nil && batch.TerminalEvidence.RuntimeEpoch == intent.Epoch {
			return errors.New("retirement has outstanding terminal receipt")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		for _, sample := range batch.Samples {
			key := sample.CounterEpoch + "\x00" + sample.SubjectID + "\x00" + sample.RouteID + "\x00" + sample.MeasurementLayer
			if retiring[key] {
				return errors.New("managed retirement has outstanding receipt")
			}
		}
	}
	// Validate BOTH remaining fingerprints before removing either. A changed
	// final or new running marker blocks deletion rather than rewriting evidence.
	files := []struct{ name, digest string }{{intent.Epoch + ".baseline.json", intent.BaselineDigest}, {intent.Epoch + ".final.json", intent.FinalDigest}}
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return err
		}
		raw, err := readRetirementFile(dir, file.name)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if journalDigest(raw) != file.digest {
			return errors.New("managed retirement journal changed")
		}
	}
	// When both originals remain, also bind the WAL's file fingerprints and
	// cursor set to the exact canonical proof acknowledged by the CP.
	baseRaw, baseErr := readRetirementFile(dir, intent.Epoch+".baseline.json")
	finalRaw, finalErr := readRetirementFile(dir, intent.Epoch+".final.json")
	if baseErr == nil && finalErr == nil {
		baseline, err := decodeRetirementSnapshot(baseRaw, intent.Epoch)
		if err != nil {
			return err
		}
		final, err := decodeRetirementSnapshot(finalRaw, intent.Epoch)
		if err != nil {
			return err
		}
		evidence := entrypolicy.TerminalEvidence{Version: entrypolicy.TerminalCustodyVersion, NodeID: s.disk.Scope.NodeID, InstanceID: s.disk.Scope.InstanceID, EnrollmentEpoch: s.disk.Scope.EnrollmentEpoch, RuntimeEpoch: intent.Epoch, Baseline: baseline, Final: final}
		evidence.Digest = evidence.ComputeDigest()
		if evidence.Validate() != nil || evidence.Digest != intent.Custody.EvidenceDigest || len(intent.Keys) != len(final.Counters) {
			return errors.New("retirement files differ from acknowledged terminal proof")
		}
		keys := map[string]bool{}
		for _, c := range final.Counters {
			keys[meterSourceKey(c)] = true
		}
		for _, key := range intent.Keys {
			if !keys[key] {
				return errors.New("retirement cursor set differs from terminal proof")
			}
			delete(keys, key)
		}
	}
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return err
		}
		running, err := runningEpoch(dir)
		if err != nil {
			return err
		}
		if running == intent.Epoch {
			return errors.New("managed retirement epoch is running")
		}
		raw, err := readRetirementFile(dir, file.name)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if journalDigest(raw) != file.digest {
			return errors.New("managed retirement journal changed")
		}
		if err = dir.Remove(file.name); err != nil {
			return err
		}
	}
	f, err := dir.Open(".")
	if err != nil {
		return err
	}
	err = f.Sync()
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	next := s.disk
	next.TerminalCustody = make(map[string]terminalCustody, len(s.disk.TerminalCustody))
	for k, v := range s.disk.TerminalCustody {
		if k != intent.Epoch {
			next.TerminalCustody[k] = v
		}
	}
	next.ManagedSources = make(map[string]managedMeterCursor, len(s.disk.ManagedSources))
	for key, cursor := range s.disk.ManagedSources {
		next.ManagedSources[key] = cursor
	}
	for _, key := range intent.Keys {
		delete(next.ManagedSources, key)
	}
	if err = s.persistRetirement(next); err != nil {
		return err
	}
	if err = os.Remove(filepath.Join(s.root, "managed-retirement.json")); err != nil {
		return err
	}
	return syncDir(s.root)
}
