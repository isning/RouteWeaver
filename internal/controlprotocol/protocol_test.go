package controlprotocol

import (
	"encoding/json"
	"strings"
	"testing"

	"routeweaver/internal/domain"
)

func TestWirePreservesLargeGenerationAsDecimalString(t *testing.T) {
	d := Desired{Generation: 9007199254740993}
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"generation":"9007199254740993"`) {
		t.Fatalf("generation lost JSON precision: %s", b)
	}
	var restored Desired
	if err = json.Unmarshal(b, &restored); err != nil || restored.Generation != 9007199254740993 {
		t.Fatalf("roundtrip: %+v %v", restored, err)
	}
	if err = json.Unmarshal([]byte(`{"generation":9007199254740993}`), &restored); err == nil {
		t.Fatal("numeric generation accepted")
	}
}
func TestArtifactIntegrityIsCanonicalAndScopeBound(t *testing.T) {
	a := []domain.Artifact{{Path: "b.json", Content: "{}"}, {Path: "a.json", Content: "[]"}}
	digest, err := ArtifactDigest(a)
	if err != nil {
		t.Fatal(err)
	}
	reversed := []domain.Artifact{a[1], a[0]}
	same, err := ArtifactDigest(reversed)
	if err != nil || same != digest {
		t.Fatal("artifact order changed canonical digest")
	}
	scope := Scope{NodeID: "node-a", InstanceID: "core-a", EnrollmentEpoch: "epoch-a"}
	d := Desired{Scope: scope, Generation: 1, RevisionID: "revision-a", OperationID: "operation-a", EntryFile: "a.json", Artifacts: a, Digest: digest}
	if err = ValidateDesired(d, scope); err != nil {
		t.Fatal(err)
	}
	foreign := scope
	foreign.EnrollmentEpoch = "epoch-b"
	if ValidateDesired(d, foreign) == nil {
		t.Fatal("foreign epoch accepted")
	}
	d.Artifacts[0].Content = "changed"
	if ValidateDesired(d, scope) == nil {
		t.Fatal("artifact change missed")
	}
}
func TestMeterDigestExcludesOnlyReceiptDigestField(t *testing.T) {
	b := MeterBatch{StreamEpoch: "stream", Sequence: 1, Samples: []MeterSample{{SampleID: "sample-a", CumulativeBytes: 10}}}
	first, err := MeterBatchDigest(b)
	if err != nil {
		t.Fatal(err)
	}
	b.Digest = "prior-digest"
	same, _ := MeterBatchDigest(b)
	if first != same {
		t.Fatal("digest included itself")
	}
	b.Sequence = 2
	other, _ := MeterBatchDigest(b)
	if other == first {
		t.Fatal("sequence not bound to batch digest")
	}
}

func TestCoreTransitionRequiresExactCatalogIdentity(t *testing.T) {
	scope := Scope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}
	artifacts := []domain.Artifact{{Path: "config.json", Content: "{}"}}
	digest, _ := ArtifactDigest(artifacts)
	release, _ := FindCoreRelease("xray-26.3.27-linux-amd64")
	from := Identity{Scope: scope, AdapterID: "routeweaver/xray", CoreVersion: "26.2.6", Generation: 1, RevisionID: "old", OperationID: "old-op", Digest: digest}
	d := Desired{Scope: scope, AdapterID: release.AdapterID, CoreVersion: release.Version, Generation: 2, RevisionID: "next", OperationID: "next-op", Digest: digest, EntryFile: "config.json", Artifacts: artifacts, Action: "upgrade", CoreReleaseID: release.ID, Transition: &CoreTransition{From: from, ReleaseID: release.ID, ExecutableSHA256: release.ExecutableSHA256}}
	if err := ValidateDesired(d, scope); err != nil {
		t.Fatal(err)
	}
	d.Transition.From.InstanceID = "other"
	if err := ValidateDesired(d, scope); err == nil {
		t.Fatal("cross-instance transition accepted")
	}
	d.Transition.From = from
	d.Transition.ExecutableSHA256 = "wrong"
	if err := ValidateDesired(d, scope); err == nil {
		t.Fatal("unpinned target executable accepted")
	}
	d.Transition.ExecutableSHA256 = release.ExecutableSHA256
	d.Transition.From.CoreVersion = release.Version
	if err := ValidateDesired(d, scope); err == nil {
		t.Fatal("same-version fake upgrade accepted")
	}
}
