// Proposed first public-seam test. Not compiled/run; copy only after P1 integration.
package httpapi_test

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"routeweaver/internal/httpapi"
	"strings"
	"testing"
)

type publicationLostReplyTransport struct {
	base    http.RoundTripper
	dropped bool
}

func (tr *publicationLostReplyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	response, err := tr.base.RoundTrip(r)
	if err != nil {
		return response, err
	}
	if !tr.dropped && r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/publish") && response.StatusCode == 200 {
		tr.dropped = true
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		return nil, io.ErrUnexpectedEOF
	}
	return response, nil
}
func TestPublicationRequestLostAcceptedResponseDoesNotCreateSecondGeneration(t *testing.T) {
	f := newFleetFixture(t)
	admin := operatorClient()
	url := f.srv.URL + "/api/server-deployments/" + f.in.DeploymentID
	opened := openServerDraft(t, admin, url)
	checked := requireServerValidation(t, admin, url, opened["revisionToken"].(string))
	input := map[string]any{"operationId": "lost-publication", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": checked["fingerprint"]}
	payload, _ := json.Marshal(input)
	base := admin.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	transport := &publicationLostReplyTransport{base: base}
	lossy := *admin
	lossy.Transport = transport
	request, _ := http.NewRequest("POST", url+"/publish", strings.NewReader(string(payload)))
	request.Header.Set("Content-Type", "application/json")
	response, err := lossy.Do(request)
	if response != nil {
		response.Body.Close()
	}
	if err == nil || !errors.Is(err, io.ErrUnexpectedEOF) || !transport.dropped {
		t.Fatalf("expected response loss after real acceptance, got %v", err)
	}
	// Read-only receipt lookup must resolve exact original request without another
	// publication. Runtime status is a distinct existing read-model.
	code, receipt, raw := req(t, admin, "GET", url+"/publication-requests/lost-publication", "", nil)
	if code != 200 {
		t.Fatalf("receipt lookup %d %s", code, raw)
	}
	result, ok := receipt["result"].(map[string]any)
	if !ok || result["status"] != "publication-accepted" || result["operationId"] != "lost-publication" || result["deploymentId"] != f.in.DeploymentID {
		t.Fatalf("unbound result %s", raw)
	}
	before := map[string]any{}
	for _, id := range f.in.TargetIDs {
		code, state, raw := req(t, admin, "GET", f.srv.URL+"/api/agent/instances/"+id+"/state", "", nil)
		if code != 200 {
			t.Fatalf("state %d %s", code, raw)
		}
		before[id] = state["desired"]
	}
	code, replay, raw := req(t, admin, "POST", url+"/publish", "", input)
	if code != 200 || !reflect.DeepEqual(replay, result) {
		t.Fatalf("replay differed %d %s", code, raw)
	}
	for _, id := range f.in.TargetIDs {
		code, state, raw := req(t, admin, "GET", f.srv.URL+"/api/agent/instances/"+id+"/state", "", nil)
		if code != 200 || !reflect.DeepEqual(state["desired"], before[id]) {
			t.Fatalf("retry changed generated identity %d %s", code, raw)
		}
	}
}

// Characterizes the old public retry seam without the new request field. Keep
// this regression: unbound legacy submissions must not create desired state.
func TestPublicationRequestRequiresStableOperationIdentity(t *testing.T) {
	f := newFleetFixture(t)
	admin := operatorClient()
	url := f.srv.URL + "/api/server-deployments/" + f.in.DeploymentID
	opened := openServerDraft(t, admin, url)
	checked := requireServerValidation(t, admin, url, opened["revisionToken"].(string))
	body := map[string]any{"leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": checked["fingerprint"]}
	code, _, raw := req(t, admin, "POST", url+"/publish", "", body)
	if code != 400 {
		t.Fatalf("unbound publication accepted: %d %s", code, raw)
	}
	for _, id := range f.in.TargetIDs {
		code, state, raw := req(t, admin, "GET", f.srv.URL+"/api/agent/instances/"+id+"/state", "", nil)
		if code != 200 || state["desired"] != nil {
			t.Fatalf("unbound request wrote desired %d %s", code, raw)
		}
	}
}

func publicationFixtureInput(t *testing.T, f fleetFixture, op string) (string, map[string]any) {
	t.Helper()
	url := f.srv.URL + "/api/server-deployments/" + f.in.DeploymentID
	opened := openServerDraft(t, operatorClient(), url)
	checked := requireServerValidation(t, operatorClient(), url, opened["revisionToken"].(string))
	return url, map[string]any{"operationId": op, "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": checked["fingerprint"]}
}
func publicationDesired(t *testing.T, f fleetFixture) map[string]any {
	t.Helper()
	out := map[string]any{}
	for _, id := range f.in.TargetIDs {
		code, state, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/agent/instances/"+id+"/state", "", nil)
		if code != 200 {
			t.Fatal(code, raw)
		}
		out[id] = state["desired"]
	}
	return out
}
func TestPublicationRequestConcurrentSameOperationHasOneGeneration(t *testing.T) {
	f := newFleetFixture(t)
	url, input := publicationFixtureInput(t, f, "concurrent-publication")
	type answer struct {
		code int
		body map[string]any
		raw  string
	}
	answers := make(chan answer, 8)
	start := make(chan struct{})
	for range 8 {
		go func() {
			<-start
			payload, _ := json.Marshal(input)
			request, _ := http.NewRequest("POST", url+"/publish", strings.NewReader(string(payload)))
			request.Header.Set("Content-Type", "application/json")
			response, err := operatorClient().Do(request)
			if err != nil {
				answers <- answer{raw: err.Error()}
				return
			}
			raw, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				answers <- answer{raw: err.Error()}
				return
			}
			body := map[string]any{}
			_ = json.Unmarshal(raw, &body)
			answers <- answer{response.StatusCode, body, string(raw)}
		}()
	}
	close(start)
	var first map[string]any
	for range 8 {
		a := <-answers
		if a.code != 200 || a.body["status"] != "publication-accepted" {
			t.Fatalf("concurrent result %d %s", a.code, a.raw)
		}
		if first == nil {
			first = a.body
		} else if !reflect.DeepEqual(first, a.body) {
			t.Fatal("concurrent receipt differs")
		}
	}
	for _, item := range first["instances"].([]any) {
		if item.(map[string]any)["generation"] != "1" {
			t.Fatal("more than one generation", first)
		}
	}
	records, err := f.s.List("published-manifests")
	if err != nil || len(records) != len(f.in.TargetIDs) {
		t.Fatalf("duplicate manifests %d %v", len(records), err)
	}
}
func TestPublicationRequestOldReceiptCannotRenewOrReplaceNewDesired(t *testing.T) {
	f := newFleetFixture(t)
	url, input := publicationFixtureInput(t, f, "original-publication")
	code, original, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
	if code != 200 || original["status"] != "publication-accepted" {
		t.Fatal(code, raw)
	}
	originalDesired := publicationDesired(t, f)
	input["operationId"] = "intentional-renewal"
	input["leaseSeconds"] = 600
	code, newer, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
	if code != 200 || newer["status"] != "publication-accepted" {
		t.Fatal(code, raw)
	}
	latest := publicationDesired(t, f)
	if reflect.DeepEqual(originalDesired, latest) {
		t.Fatal("intentional new request did not advance")
	}
	input["operationId"] = "original-publication"
	input["leaseSeconds"] = 300
	code, replayed, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
	if code != 200 || !reflect.DeepEqual(original, replayed) {
		t.Fatal("historical replay changed", code, raw)
	}
	if !reflect.DeepEqual(latest, publicationDesired(t, f)) {
		t.Fatal("historical acknowledgement changed current desired")
	}
	code, lookup, raw := req(t, operatorClient(), "GET", url+"/publication-requests/original-publication", "", nil)
	if code != 200 || !reflect.DeepEqual(lookup["result"], original) || lookup["request"].(map[string]any)["leaseSeconds"] != float64(300) {
		t.Fatal("original receipt lease changed", code, raw)
	}
}
func TestPublicationRequestLostRejectionRemainsTerminalAfterDraftRestored(t *testing.T) {
	f := newFleetFixture(t)
	url, input := publicationFixtureInput(t, f, "rejected-publication")
	var original httpapi.ServerDeployment
	if err := f.s.Get("server-deployments", f.in.DeploymentID, &original); err != nil {
		t.Fatal(err)
	}
	changed := original
	changed.IR.TopologyRevision = "changed-review"
	if err := f.s.Put("server-deployments", changed.ID, changed); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(input)
	transport := &publicationLostReplyTransport{base: operatorClient().Transport}
	client := &http.Client{Transport: transport}
	request, _ := http.NewRequest("POST", url+"/publish", strings.NewReader(string(payload)))
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if response != nil {
		response.Body.Close()
	}
	if !errors.Is(err, io.ErrUnexpectedEOF) || !transport.dropped {
		t.Fatalf("did not lose terminal rejection %v", err)
	}
	if err := f.s.Put("server-deployments", original.ID, original); err != nil {
		t.Fatal(err)
	}
	code, receipt, raw := req(t, operatorClient(), "GET", url+"/publication-requests/rejected-publication", "", nil)
	if code != 200 {
		t.Fatal(code, raw)
	}
	rejected := receipt["result"].(map[string]any)
	if rejected["status"] != "definitively-rejected" || rejected["code"] != "SERVER_DRAFT_CHANGED" {
		t.Fatal(raw)
	}
	code, replayed, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
	if code != 200 || !reflect.DeepEqual(replayed, rejected) {
		t.Fatal("rejected operation was resurrected", code, raw)
	}
	for _, desired := range publicationDesired(t, f) {
		if desired != nil {
			t.Fatal("rejection wrote desired")
		}
	}
	input["operationId"] = "reviewed-fresh-submission"
	code, accepted, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
	if code != 200 || accepted["status"] != "publication-accepted" {
		t.Fatal(code, raw)
	}
}

func TestPublicationRequestAcceptedReplayPrecedesMutableReadiness(t *testing.T) {
	for _, change := range []string{"draft-changed", "deployment-deleted", "enrollment-revoked"} {
		t.Run(change, func(t *testing.T) {
			f := newFleetFixture(t)
			url, input := publicationFixtureInput(t, f, "accepted-before-drift")
			code, accepted, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
			if code != 200 || accepted["status"] != "publication-accepted" {
				t.Fatal(code, raw)
			}
			baseline := publicationDesired(t, f)
			switch change {
			case "draft-changed":
				var d httpapi.ServerDeployment
				if err := f.s.Get("server-deployments", f.in.DeploymentID, &d); err != nil {
					t.Fatal(err)
				}
				d.IR.TopologyRevision = "later-draft"
				if err := f.s.Put("server-deployments", d.ID, d); err != nil {
					t.Fatal(err)
				}
			case "deployment-deleted":
				if err := f.s.Remove("server-deployments", f.in.DeploymentID); err != nil {
					t.Fatal(err)
				}
			case "enrollment-revoked":
				var en httpapi.Enrollment
				if err := f.s.Get("instance-enrollments", f.in.TargetIDs[0], &en); err != nil {
					t.Fatal(err)
				}
				en.Revoked = true
				if err := f.s.Put("instance-enrollments", f.in.TargetIDs[0], en); err != nil {
					t.Fatal(err)
				}
			}
			code, replayed, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
			if code != 200 || !reflect.DeepEqual(replayed, accepted) {
				t.Fatal("mutable readiness hid historical receipt", code, raw)
			}
			code, lookup, raw := req(t, operatorClient(), "GET", url+"/publication-requests/accepted-before-drift", "", nil)
			if code != 200 || !reflect.DeepEqual(lookup["result"], accepted) {
				t.Fatal("lookup hid historical receipt", code, raw)
			}
			if !reflect.DeepEqual(baseline, publicationDesired(t, f)) {
				t.Fatal("historical replay changed current desired")
			}
		})
	}
}
