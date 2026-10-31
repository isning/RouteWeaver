package store_test

import (
	"context"
	"encoding/json"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestBackupStreamingDoesNotBlockAdmissionOrConfigurationWrites(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	if _, err := s.GenerateRecord("agent-desired", "core1", func(g uint64) (any, error) { return map[string]uint64{"generation": g}, nil }); err != nil {
		t.Fatal(err)
	}
	entered, release, exportDone := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	var recordGeneration, counterGeneration uint64
	go func() {
		first := true
		exportDone <- s.ExportBackup(context.Background(), store.BackupLimits{MaxBytes: 1 << 20, MaxRows: 1000, MaxRecordBytes: 1 << 20}, func(f store.BackupFrame) error {
			if first {
				first = false
				close(entered)
				<-release
			}
			if f.Record != nil && f.Record.Kind == "agent-desired" {
				var v struct{ Generation uint64 }
				if e := json.Unmarshal(f.Record.Data, &v); e != nil {
					return e
				}
				recordGeneration = v.Generation
			}
			if f.Counter != nil && f.Counter.Kind == "agent-desired" {
				counterGeneration = uint64(f.Counter.Value)
			}
			return nil
		})
	}()
	<-entered
	workDone := make(chan error, 1)
	go func() {
		if _, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.10", "during-backup"), now); err != nil {
			workDone <- err
			return
		}
		_, err := s.GenerateRecord("agent-desired", "core1", func(g uint64) (any, error) { return map[string]uint64{"generation": g}, nil })
		workDone <- err
	}()
	blocked := false
	select {
	case err := <-workDone:
		if err != nil {
			close(release)
			<-exportDone
			t.Fatal(err)
		}
	case <-time.After(500 * time.Millisecond):
		blocked = true
	}
	close(release)
	if err := <-exportDone; err != nil {
		t.Fatal(err)
	}
	if blocked {
		if err := <-workDone; err != nil {
			t.Fatal(err)
		}
		t.Fatal("live admission/configuration waited for backup emitter")
	}
	if recordGeneration != 1 || counterGeneration != 1 {
		t.Fatalf("snapshot lost transaction isolation: %d/%d", recordGeneration, counterGeneration)
	}
}
