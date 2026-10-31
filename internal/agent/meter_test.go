package agent

import (
	"os"
	"testing"
	"time"
)

func TestMeterBatchesAreDurableSequencedAndScoped(t *testing.T) {
	root := t.TempDir()
	os.Chmod(root, 0700)
	scope := testDesired(t, 1).Scope
	s, err := OpenMeterSpool(root, scope, "stream-1")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	sample := MeterSample{SampleID: "sample-1", CounterEpoch: "core-boot-1", SubjectID: "user-a", RouteID: "route-a", PolicyRevision: "policy-1", CycleID: "cycle-1", MeasurementLayer: "entry_payload", CumulativeBytes: 9007199254740993, ObservedAt: time.Now()}
	b1, err := s.Enqueue([]MeterSample{sample})
	if err != nil {
		t.Fatal(err)
	}
	sample.SampleID = "sample-2"
	b2, err := s.Enqueue([]MeterSample{sample})
	if err != nil {
		t.Fatal(err)
	}
	if b1.Sequence != 1 || b2.Sequence != 2 {
		t.Fatal("wrong sequence")
	}
	if err = s.Ack(MeterReceipt{StreamEpoch: b2.StreamEpoch, Sequence: b2.Sequence, Digest: b2.Digest}); err == nil {
		t.Fatal("ack skipped first batch")
	}
	s.Close()
	s, err = OpenMeterSpool(root, scope, "stream-1")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pending := s.Pending()
	if len(pending) != 2 || pending[0].Digest != b1.Digest || pending[0].Samples[0].CumulativeBytes != 9007199254740993 {
		t.Fatal("restart changed durable meter evidence")
	}
	if err = s.Ack(MeterReceipt{StreamEpoch: b1.StreamEpoch, Sequence: b1.Sequence, Digest: "changed-digest"}); err == nil {
		t.Fatal("wrong digest acknowledged")
	}
	if err = s.Ack(MeterReceipt{StreamEpoch: b1.StreamEpoch, Sequence: b1.Sequence, Digest: b1.Digest}); err != nil {
		t.Fatal(err)
	}
	if len(s.Pending()) != 1 {
		t.Fatal("ack removed wrong count")
	}
}
