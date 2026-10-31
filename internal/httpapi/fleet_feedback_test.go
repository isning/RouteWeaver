package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"routeweaver/internal/httpapi"
)

func TestFleetCreateReviewChangedHasAdditiveSafeFeedbackCode(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "changed-review", true: "missing-review"}[missing], func(t *testing.T) {
			f := newFleetFixture(t)
			plan := f.post(t, "admin/fleet-batches/preview", f.in, 200)
			var deployment httpapi.ServerDeployment
			if err := f.s.Get("server-deployments", f.in.DeploymentID, &deployment); err != nil {
				t.Fatal(err)
			}
			deployment.IR.TopologyRevision = "changed-after-review"
			f.saveDeployment(t, deployment)
			raw, _ := json.Marshal(f.in)
			var in map[string]any
			json.Unmarshal(raw, &in)
			in["leaseSeconds"] = 300
			if !missing {
				in["expectedFingerprint"] = plan["fingerprint"]
			}
			before, err := f.s.List("fleet-batches")
			if err != nil {
				t.Fatal(err)
			}
			payload, _ := json.Marshal(in)
			request, _ := http.NewRequest("POST", f.srv.URL+"/api/admin/fleet-batches", bytes.NewReader(payload))
			request.Header.Set("Content-Type", "application/json")
			result, err := operatorClient().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer result.Body.Close()
			if result.StatusCode != 409 || !strings.HasPrefix(result.Header.Get("Content-Type"), "application/json") {
				t.Fatalf("error envelope transport changed: status=%d type=%q", result.StatusCode, result.Header.Get("Content-Type"))
			}
			var response map[string]any
			if err := json.NewDecoder(result.Body).Decode(&response); err != nil {
				t.Fatal(err)
			}
			if response["code"] != "FLEET_REVIEW_CHANGED" {
				t.Errorf("typed fingerprint conflict missing: %#v", response)
			}
			if response["detail"] != "plan inputs changed; preview again before creating the batch" {
				t.Fatalf("legacy detail contract changed: %#v", response)
			}
			after, err := f.s.List("fleet-batches")
			if err != nil || len(after) != len(before) {
				t.Fatalf("rejected review wrote a batch: before=%d after=%d err=%v", len(before), len(after), err)
			}
		})
	}
}

func TestFleetCreateOtherFailureDoesNotClaimReviewChanged(t *testing.T) {
	f := newFleetFixture(t)
	raw, _ := json.Marshal(f.in)
	var in map[string]any
	json.Unmarshal(raw, &in)
	in["leaseSeconds"] = 1
	response := f.post(t, "admin/fleet-batches", in, 400)
	if response["code"] == "FLEET_REVIEW_CHANGED" {
		t.Fatalf("unrelated rejection classified as review drift: %#v", response)
	}
}

func TestFleetOwnershipConflictDoesNotClaimFingerprintChanged(t *testing.T) {
	f := newFleetFixture(t)
	publishOwned(t, f, f.in.DeploymentID, 200)
	copyOwned(t, f, "other-deployment")
	f.in.DeploymentID = "other-deployment"
	raw, _ := json.Marshal(f.in)
	var in map[string]any
	json.Unmarshal(raw, &in)
	in["leaseSeconds"] = 300
	in["expectedFingerprint"] = "previous-review"
	response := f.post(t, "admin/fleet-batches", in, 409)
	if response["code"] == "FLEET_REVIEW_CHANGED" {
		t.Fatalf("ownership conflict classified as fingerprint drift: %#v", response)
	}
}
