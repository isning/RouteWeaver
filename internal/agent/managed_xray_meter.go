package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"routeweaver/internal/entrypolicy"
	"sort"
	"time"
)

type managedMeterCursor struct {
	Value      uint64    `json:"value,string"`
	ObservedAt time.Time `json:"observedAt"`
}

// EnqueueManagedSnapshot atomically persists source cursors with the outbox.
// Restart cannot duplicate an old zero baseline after a newer cumulative value.
// Unknown nonzero epochs are rejected, never given an invented baseline.
func (s *MeterSpool) EnqueueManagedSnapshot(snapshot entrypolicy.Snapshot) error {
	if snapshot.AdapterID != ManagedXrayID || snapshot.RuntimeVersion != ManagedXrayVersion || snapshot.LedgerMode != "admission-budget" || snapshot.ObservedAt.IsZero() || len(snapshot.Counters) == 0 || len(snapshot.Counters) > 1000 {
		return errors.New("invalid managed snapshot")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sources := map[string]managedMeterCursor{}
	for k, v := range s.disk.ManagedSources {
		sources[k] = v
	}
	samples := []MeterSample{}
	for _, c := range snapshot.Counters {
		if c.CounterEpoch == "" || c.SubjectID == "" || c.RouteID == "" || c.PolicyRevision == "" || c.CycleID == "" || c.MeasurementLayer != entrypolicy.MeasurementLayer || c.CumulativeBytes != c.UploadBytes+c.DownloadBytes {
			return errors.New("invalid managed counter binding")
		}
		key := c.CounterEpoch + "\x00" + c.SubjectID + "\x00" + c.RouteID + "\x00" + c.MeasurementLayer
		previous, exists := sources[key]
		if exists {
			if !snapshot.ObservedAt.After(previous.ObservedAt) {
				if c.CumulativeBytes <= previous.Value {
					continue
				}
				return errors.New("managed counter clock moved backward")
			}
			if c.CumulativeBytes < previous.Value {
				return errors.New("managed counter regressed")
			}
			if c.CumulativeBytes == previous.Value {
				continue
			}
		} else if c.CumulativeBytes != 0 {
			return errors.New("managed counter needs actual zero baseline")
		}
		sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d", key, snapshot.ObservedAt.UTC().Format(time.RFC3339Nano), c.CumulativeBytes)))
		samples = append(samples, MeterSample{LedgerMode: snapshot.LedgerMode, SampleID: "native-" + hex.EncodeToString(sum[:16]), CounterEpoch: c.CounterEpoch, SubjectID: c.SubjectID, RouteID: c.RouteID, PolicyRevision: c.PolicyRevision, CycleID: c.CycleID, MeasurementLayer: c.MeasurementLayer, CumulativeBytes: c.CumulativeBytes, ObservedAt: snapshot.ObservedAt})
		sources[key] = managedMeterCursor{Value: c.CumulativeBytes, ObservedAt: snapshot.ObservedAt}
	}
	if len(samples) == 0 {
		return nil
	}
	_, err := s.enqueueLocked(samples, sources)
	return err
}

// CollectManagedCounters always consumes retained genuine baselines/finals in
// time order before reading live counters. Its errors must backpressure access.
func CollectManagedCounters(ctx context.Context, root string, spool *MeterSpool, live bool) error {
	if spool == nil {
		return errors.New("managed runtime requires durable meter spool")
	}
	spool.collectMu.Lock()
	defer spool.collectMu.Unlock()
	if err := spool.compactManagedJournal(ctx, root); err != nil {
		return err
	}
	snapshots, err := ReadManagedJournal(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	sort.SliceStable(snapshots, func(i, j int) bool { return snapshots[i].ObservedAt.Before(snapshots[j].ObservedAt) })
	for _, s := range snapshots {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err = spool.EnqueueManagedSnapshot(s); err != nil {
			return err
		}
	}
	if !live {
		return nil
	}
	s, err := ReadManagedSnapshot(ctx, root)
	if err != nil {
		return err
	}
	// A finalized process can briefly still answer IPC before its channels
	// close. Never recreate an already-retired zero cursor from that response.
	dir, err := os.OpenRoot(ManagedJournalDirectory(root))
	if err != nil {
		return err
	}
	epoch, err := runningEpoch(dir)
	dir.Close()
	if err != nil {
		return err
	}
	if epoch == "" || epoch != s.CounterEpoch {
		return errors.New("live managed snapshot has no matching running epoch")
	}
	return spool.EnqueueManagedSnapshot(s)
}
