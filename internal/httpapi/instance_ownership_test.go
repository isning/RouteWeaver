package httpapi_test

import (
	"fmt"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/store"
	"sync/atomic"
	"testing"
	"time"
)

var publicationCallerSequence atomic.Uint64

// Each call represents a new, deliberately reviewed publication, not a retry.
func nextPublicationCallerID() string {
	return fmt.Sprintf("test-publication-%d", publicationCallerSequence.Add(1))
}

func publishOwned(t *testing.T, f fleetFixture, id string, want int) map[string]any {
	t.Helper()
	opened := openServerDraft(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+id)
	review := requireServerValidation(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+id, opened["revisionToken"].(string))
	operationID := nextPublicationCallerID()
	result := f.post(t, "server-deployments/"+id+"/publish", map[string]any{"operationId": operationID, "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": review["fingerprint"]}, 200)
	if result["operationId"] != operationID || result["deploymentId"] != id {
		t.Fatalf("publication result identity mismatch: %v", result)
	}
	switch want {
	case 200:
		if result["status"] != "publication-accepted" || result["nativeChecked"] != false {
			t.Fatalf("expected queued publication, got %v", result)
		}
	case 409:
		if result["status"] != "definitively-rejected" || result["code"] != "PUBLICATION_REJECTED" {
			t.Fatalf("expected ownership rejection, got %v", result)
		}
	default:
		t.Fatalf("unsupported publication expectation %d", want)
	}
	return result
}
func copyOwned(t *testing.T, f fleetFixture, id string) {
	t.Helper()
	var d httpapi.ServerDeployment
	if e := f.s.Get("server-deployments", f.in.DeploymentID, &d); e != nil {
		t.Fatal(e)
	}
	d.ID = id
	d.IR.ID = id
	f.saveDeployment(t, d)
}
func TestPublishRejectsForeignInstanceOwnerWithoutWrites(t *testing.T) {
	f := newFleetFixture(t)
	publishOwned(t, f, f.in.DeploymentID, 200)
	copyOwned(t, f, "other-deployment")
	publishOwned(t, f, "other-deployment", 409)
	for _, id := range f.in.TargetIDs {
		var d controlprotocol.Desired
		if e := f.s.Get("agent-desired", id, &d); e != nil || d.Generation != 1 {
			t.Fatalf("conflict changed desired: %+v %v", d, e)
		}
	}
	manifests, e := f.s.List("published-manifests")
	if e != nil || len(manifests) != 2 {
		t.Fatalf("conflict wrote manifests: %d %v", len(manifests), e)
	}
	publishOwned(t, f, f.in.DeploymentID, 200)
}

func TestFleetActivationRejectsDirectForeignOwner(t *testing.T) {
	f := newFleetFixture(t)
	publishOwned(t, f, f.in.DeploymentID, 200)
	copyOwned(t, f, "other-deployment")
	f.in.DeploymentID = "other-deployment"
	for _, action := range []string{"configure", "start"} {
		f.in.Action = action
		f.post(t, "admin/fleet-batches/preview", f.in, 409)
	}
}

func TestPublishConflictIsAtomicAcrossTargets(t *testing.T) {
	f := newFleetFixture(t)
	copyOwned(t, f, "other-deployment")
	var original httpapi.ServerDeployment
	f.s.Get("server-deployments", f.in.DeploymentID, &original)
	original.IR.Programs = original.IR.Programs[1:]
	f.saveDeployment(t, original)
	publishOwned(t, f, f.in.DeploymentID, 200)
	publishOwned(t, f, "other-deployment", 409)
	var desired controlprotocol.Desired
	if err := f.s.Get("agent-desired", "fleet-a", &desired); err != store.ErrNotFound {
		t.Fatalf("unowned first target partially queued: %+v %v", desired, err)
	}
}

func TestLegacyOwnershipRequiresExactPublicationEvidence(t *testing.T) {
	for _, mode := range []string{"matching", "missing", "mismatched", "contradictory"} {
		t.Run(mode, func(t *testing.T) {
			f := newFleetFixture(t)
			publishOwned(t, f, f.in.DeploymentID, 200)
			for _, id := range f.in.TargetIDs {
				if e := f.s.Remove("instance-owners", id); e != nil {
					t.Fatal(e)
				}
			}
			var d controlprotocol.Desired
			f.s.Get("agent-desired", "fleet-a", &d)
			switch mode {
			case "missing":
				f.s.Remove("published-manifests", d.RevisionID)
			case "mismatched":
				var m domain.PublishedManifest
				f.s.Get("published-manifests", d.RevisionID, &m)
				m.Identity.Digest = "wrong"
				f.s.Put("published-manifests", d.RevisionID, m)
			case "contradictory":
				var m domain.PublishedManifest
				f.s.Get("published-manifests", d.RevisionID, &m)
				identity := d.Identity()
				identity.RevisionID = "foreign-revision"
				m.Identity.RevisionID = identity.RevisionID
				m.DeploymentID = "foreign-deployment"
				f.s.Put("published-manifests", identity.RevisionID, m)
				f.s.Put("agent-observations", "fleet-a", controlprotocol.State{Observed: &controlprotocol.Observation{Identity: identity}})
			}
			want := 409
			if mode == "matching" {
				want = 200
			}
			publishOwned(t, f, f.in.DeploymentID, want)
		})
	}
}

func TestFleetOwnerSurvivesStopAndRejectsForeignDirectPublish(t *testing.T) {
	f := newFleetFixture(t)
	id := f.create(t)
	f.post(t, "admin/fleet-batches/"+id+"/execute", map[string]any{"stage": 0, "requestId": "claim"}, 200)
	copyOwned(t, f, "other-deployment")
	publishOwned(t, f, "other-deployment", 409)
	f.in.Action = "stop"
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = [][]string{{"fleet-a"}}
	stop := f.create(t)
	f.post(t, "admin/fleet-batches/"+stop+"/execute", map[string]any{"stage": 0, "requestId": "stop"}, 200)
	publishOwned(t, f, "other-deployment", 409)
	publishOwned(t, f, "fleet-deployment", 200)
}

func TestNonactivatingInstallDoesNotClaimOrReleaseOwner(t *testing.T) {
	for _, configured := range []bool{false, true} {
		t.Run(fmt.Sprint(configured), func(t *testing.T) {
			f := newFleetFixture(t)
			if configured {
				publishOwned(t, f, f.in.DeploymentID, 200)
			}
			copyOwned(t, f, "other-deployment")
			f.in.DeploymentID = "other-deployment"
			f.in.Action = "install"
			f.in.TargetIDs = []string{"fleet-a"}
			f.in.Stages = nil
			f.in.TargetReleaseID = "xray-26.3.27-linux-amd64"
			batch := f.create(t)
			f.post(t, "admin/fleet-batches/"+batch+"/execute", map[string]any{"stage": 0, "requestId": "install"}, 200)
			want := 200
			if configured {
				want = 409
			}
			publishOwned(t, f, "other-deployment", want)
			if configured {
				publishOwned(t, f, "fleet-deployment", 200)
			}
		})
	}
}

func TestConcurrentPublicationsCannotClaimSameInstances(t *testing.T) {
	f := newFleetFixture(t)
	copyOwned(t, f, "other-deployment")
	ids := []string{f.in.DeploymentID, "other-deployment"}
	fingerprints := map[string]any{}
	for _, id := range ids {
		opened := openServerDraft(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+id)
		fingerprints[id] = requireServerValidation(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+id, opened["revisionToken"].(string))["fingerprint"]
	}
	start := make(chan struct{})
	results := make(chan string, 2)
	for _, id := range ids {
		go func(id string) {
			<-start
			code, result, raw := req(t, operatorClient(), "POST", f.srv.URL+"/api/server-deployments/"+id+"/publish", "", map[string]any{"operationId": "claim-" + id, "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": fingerprints[id]})
			if code != 200 {
				results <- fmt.Sprintf("HTTP%d:%s", code, raw)
				return
			}
			if result["status"] == "definitively-rejected" && result["code"] != "PUBLICATION_REJECTED" {
				results <- "unexpected rejection code"
				return
			}
			results <- fmt.Sprint(result["status"])
		}(id)
	}
	close(start)
	a, b := <-results, <-results
	if !(a == "publication-accepted" && b == "definitively-rejected" || b == "publication-accepted" && a == "definitively-rejected") {
		t.Fatalf("concurrent owner results: %s %s", a, b)
	}
	for _, id := range f.in.TargetIDs {
		var desired controlprotocol.Desired
		f.s.Get("agent-desired", id, &desired)
		if desired.Generation != 1 {
			t.Fatalf("loser consumed generation: %+v", desired)
		}
	}
	manifests, _ := f.s.List("published-manifests")
	if len(manifests) != 2 {
		t.Fatalf("loser wrote manifest: %d", len(manifests))
	}
}

func TestFleetExecutionRechecksOwnerAfterPreview(t *testing.T) {
	f := newFleetFixture(t)
	copyOwned(t, f, "other-deployment")
	batch := f.create(t)
	publishOwned(t, f, "other-deployment", 200)
	f.post(t, "admin/fleet-batches/"+batch+"/execute", map[string]any{"stage": 0, "requestId": "late-claim"}, 409)
	var desired controlprotocol.Desired
	f.s.Get("agent-desired", "fleet-a", &desired)
	if desired.Generation != 1 {
		t.Fatalf("stale plan replaced owner: %+v", desired)
	}
}

func TestLegacyUnownedInstallFailsClosedButStopRemainsUsable(t *testing.T) {
	f := newFleetFixture(t)
	f.in.Action = "install"
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = nil
	f.in.TargetReleaseID = "xray-26.3.27-linux-amd64"
	batch := f.create(t)
	f.post(t, "admin/fleet-batches/"+batch+"/execute", map[string]any{"stage": 0, "requestId": "install"}, 200)
	f.s.Remove("instance-owners", "fleet-a") // Simulate a pre-migration, unproven install.
	publishOwned(t, f, f.in.DeploymentID, 409)
	f.in.Action = "stop"
	f.in.TargetReleaseID = ""
	stop := f.create(t)
	f.post(t, "admin/fleet-batches/"+stop+"/execute", map[string]any{"stage": 0, "requestId": "stop"}, 200)
	publishOwned(t, f, f.in.DeploymentID, 409)
}

func TestExpiredLeaseAndFailureDoNotReleaseOwner(t *testing.T) {
	f := newFleetFixture(t)
	publishOwned(t, f, f.in.DeploymentID, 200)
	copyOwned(t, f, "other-deployment")
	var desired controlprotocol.Desired
	f.s.Get("agent-desired", "fleet-a", &desired)
	desired.Lease.ExpiresAt = time.Now().Add(-time.Hour)
	f.s.Put("agent-desired", "fleet-a", desired)
	identity := desired.Identity()
	f.s.Put("agent-observations", "fleet-a", controlprotocol.State{Desired: &identity, Phase: controlprotocol.ApplyFailed})
	publishOwned(t, f, "other-deployment", 409)
	publishOwned(t, f, f.in.DeploymentID, 200)
}

func TestFleetUpgradeAndHistoricalRollbackRespectOwner(t *testing.T) {
	f := newFleetFixture(t)
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = nil
	original := f.create(t)
	f.post(t, "admin/fleet-batches/"+original+"/execute", map[string]any{"stage": 0, "requestId": "first"}, 200)
	f.observe(t, "fleet-a", controlprotocol.ObservedConformant)
	copyOwned(t, f, "other-deployment")
	f.in.DeploymentID = "other-deployment"
	f.in.Action = "upgrade"
	f.in.TargetReleaseID = "xray-26.3.27-linux-amd64"
	f.post(t, "admin/fleet-batches/preview", f.in, 409)
	// Simulate an explicit future transfer; a historic source cannot override it.
	f.s.Put("instance-owners", "fleet-a", map[string]any{"deploymentId": "other-deployment"})
	f.in.DeploymentID = "fleet-deployment"
	f.in.Action = "rollback"
	f.in.TargetReleaseID = ""
	f.in.SourceBatchID = original
	f.post(t, "admin/fleet-batches/preview", f.in, 409)
}

func TestMissingAcceptedRecordsCannotResetOwner(t *testing.T) {
	f := newFleetFixture(t)
	publishOwned(t, f, f.in.DeploymentID, 200)
	copyOwned(t, f, "other-deployment")
	for _, id := range f.in.TargetIDs {
		f.s.Remove("instance-owners", id)
		f.s.Remove("agent-desired", id)
	}
	publishOwned(t, f, "other-deployment", 409)
	manifests, _ := f.s.List("published-manifests")
	if len(manifests) != 2 {
		t.Fatalf("ambiguous claim wrote artifacts: %d", len(manifests))
	}
}

func TestInstallCannotLaunderMissingOwnershipHistory(t *testing.T) {
	f := newFleetFixture(t)
	publishOwned(t, f, f.in.DeploymentID, 200)
	copyOwned(t, f, "other-deployment")
	f.s.Remove("instance-owners", "fleet-a")
	f.s.Remove("agent-desired", "fleet-a")
	f.in.DeploymentID = "other-deployment"
	f.in.Action = "install"
	f.in.TargetIDs = []string{"fleet-a"}
	f.in.Stages = nil
	f.in.TargetReleaseID = "xray-26.3.27-linux-amd64"
	batch := f.create(t)
	f.post(t, "admin/fleet-batches/"+batch+"/execute", map[string]any{"stage": 0, "requestId": "install"}, 200)
	var owner map[string]any
	if e := f.s.Get("instance-owners", "fleet-a", &owner); e != store.ErrNotFound {
		t.Fatalf("install invented provenance: %v %v", owner, e)
	}
	publishOwned(t, f, "other-deployment", 409)
	f.in.Action = "stop"
	f.in.TargetReleaseID = ""
	stop := f.create(t)
	f.post(t, "admin/fleet-batches/"+stop+"/execute", map[string]any{"stage": 0, "requestId": "stop"}, 200)
	publishOwned(t, f, "other-deployment", 409)
}
