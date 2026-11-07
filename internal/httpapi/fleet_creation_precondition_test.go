package httpapi_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/fleet"
	"routeweaver/internal/httpapi"
)

func reviewedFleetCreation(t *testing.T, f fleetFixture, id string) map[string]any {
	t.Helper()
	plan := f.post(t, "admin/fleet-batches/preview", f.in, 200)
	raw, err := json.Marshal(f.in)
	if err != nil {
		t.Fatal(err)
	}
	var input map[string]any
	if err = json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	input["id"] = id
	input["expectedFingerprint"] = plan["fingerprint"]
	input["leaseSeconds"] = 300
	return input
}

func requestFleetCreation(client *http.Client, base string, input any, headers http.Header) (int, map[string]any, string, error) {
	raw, err := json.Marshal(input)
	if err != nil {
		return 0, nil, "", err
	}
	request, err := http.NewRequest("POST", base+"/api/admin/fleet-batches", bytes.NewReader(raw))
	if err != nil {
		return 0, nil, "", err
	}
	request.Header = headers.Clone()
	if request.Header == nil {
		request.Header = http.Header{}
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return response.StatusCode, nil, string(body), err
	}
	var value map[string]any
	err = json.Unmarshal(body, &value)
	return response.StatusCode, value, string(body), err
}

func createFleetWithCondition(t *testing.T, f fleetFixture, input any, conditions ...string) (int, map[string]any, string) {
	t.Helper()
	headers := http.Header{}
	for _, condition := range conditions {
		headers.Add("If-None-Match", condition)
	}
	code, value, raw, err := requestFleetCreation(operatorClient(), f.srv.URL, input, headers)
	if err != nil {
		t.Fatal(err)
	}
	return code, value, raw
}

type fleetLostCreateReplyTransport struct {
	dropped bool
}

func (tr *fleetLostCreateReplyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	response, err := (operatorTransport{}).RoundTrip(r)
	if err != nil {
		return response, err
	}
	if !tr.dropped && r.Method == "POST" && r.URL.Path == "/api/admin/fleet-batches" && response.StatusCode == 201 {
		tr.dropped = true
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		return nil, io.ErrUnexpectedEOF
	}
	return response, nil
}

func requireOnlyPlannedFleetBatch(t *testing.T, base, id string) fleet.Batch {
	t.Helper()
	code, _, raw := req(t, operatorClient(), "GET", base+"/api/admin/fleet-batches", "", nil)
	var batches []fleet.Batch
	if err := json.Unmarshal([]byte(raw), &batches); err != nil || code != 200 || len(batches) != 1 || batches[0].ID != id {
		t.Fatalf("expected exactly one batch %s: %d %s (%v)", id, code, raw, err)
	}
	batch := batches[0]
	if batch.Status != "planned" {
		t.Fatalf("creation executed batch: %+v", batch)
	}
	for _, target := range batch.Targets {
		if len(target.Attempts) != 0 || target.Status != "planned" {
			t.Fatalf("creation executed target: %+v", target)
		}
		code, state, raw := req(t, operatorClient(), "GET", base+"/api/agent/instances/"+target.InstanceID+"/state", "", nil)
		if code != 200 || state["desired"] != nil {
			t.Fatalf("creation changed desired state: %d %s", code, raw)
		}
	}
	return batch
}

func TestFleetGuardedCreationLostResponseHasOneRecoverablePlannedBatch(t *testing.T) {
	f := newFleetFixture(t)
	input := reviewedFleetCreation(t, f, "batch_lost_create")
	transport := &fleetLostCreateReplyTransport{}
	_, _, _, err := requestFleetCreation(&http.Client{Transport: transport}, f.srv.URL, input, http.Header{"If-None-Match": {"*"}})
	if !errors.Is(err, io.ErrUnexpectedEOF) || !transport.dropped {
		t.Fatalf("expected response loss after real commit: %v", err)
	}
	before := f.job(t, "batch_lost_create")
	code, rejected, raw := createFleetWithCondition(t, f, input, "*")
	if code != 412 || rejected["code"] != "FLEET_CREATION_CONFLICT" {
		t.Fatalf("same guarded request must reject occupied ID: %d %s", code, raw)
	}
	after := requireOnlyPlannedFleetBatch(t, f.srv.URL, "batch_lost_create")
	if !reflect.DeepEqual(before, after) || after.LeaseSeconds != 300 || after.Fingerprint != input["expectedFingerprint"] {
		t.Fatalf("retry changed immutable creation identity: %+v", after)
	}
	if after.ActorID != "operator" || after.Action != "configure" || after.DeploymentID != "fleet-deployment" || after.ContinuousService || after.SourceBatchID != "" || after.TargetReleaseID != "" || !reflect.DeepEqual(after.TargetIDs, []string{"fleet-a", "fleet-b"}) || !reflect.DeepEqual(after.Stages, [][]string{{"fleet-a"}, {"fleet-b"}}) {
		t.Fatalf("recovered batch differs from the reviewed request and authenticated actor: %+v", after)
	}
}

func TestFleetGuardedCreationRejectsOccupiedIDBeforeChangedDependencies(t *testing.T) {
	f := newFleetFixture(t)
	input := reviewedFleetCreation(t, f, "batch_original")
	if code, _, raw := createFleetWithCondition(t, f, input, "*"); code != 201 {
		t.Fatalf("create: %d %s", code, raw)
	}
	original := f.job(t, "batch_original")
	var deployment httpapi.ServerDeployment
	if err := f.s.Get("server-deployments", f.in.DeploymentID, &deployment); err != nil {
		t.Fatal(err)
	}
	deployment.IR.TopologyRevision = "changed-after-creation"
	f.saveDeployment(t, deployment)
	code, rejected, raw := createFleetWithCondition(t, f, input, "*")
	if code != 412 || rejected["code"] != "FLEET_CREATION_CONFLICT" {
		t.Fatalf("occupied ID reached changed review: %d %s", code, raw)
	}
	input["id"] = "batch_absent"
	code, rejected, raw = createFleetWithCondition(t, f, input, "*")
	if code != 409 || rejected["code"] != "FLEET_REVIEW_CHANGED" {
		t.Fatalf("new ID bypassed changed review: %d %s", code, raw)
	}
	input["id"] = "batch_original"
	input["deploymentId"] = "missing-deployment"
	input["action"] = "stop"
	input["leaseSeconds"] = 600
	code, rejected, raw = createFleetWithCondition(t, f, input, "*")
	if code != 412 || rejected["code"] != "FLEET_CREATION_CONFLICT" {
		t.Fatalf("occupied ID reached planning or accepted another body: %d %s", code, raw)
	}
	input["id"] = "batch_absent"
	if code, _, raw := createFleetWithCondition(t, f, input, "*"); code != 422 {
		t.Fatalf("absent-ID control must reject missing deployment: %d %s", code, raw)
	}
	if after := requireOnlyPlannedFleetBatch(t, f.srv.URL, "batch_original"); !reflect.DeepEqual(after, original) {
		t.Fatalf("changed retry overwrote original batch: %+v", after)
	}
}

func TestFleetGuardedCreationKeepsUnreadableOccupiedSlot(t *testing.T) {
	f := newFleetFixture(t)
	input := reviewedFleetCreation(t, f, "batch_unreadable")
	if code, _, raw := createFleetWithCondition(t, f, input, "*"); code != 201 {
		t.Fatalf("create: %d %s", code, raw)
	}
	// Model persisted ciphertext damage at the SQLite storage seam, not a
	// replacement Store or HTTP handler. Creation must not treat unreadability
	// as absence, and the ordinary GET must still report its read failure.
	fault, err := sql.Open("sqlite", f.databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer fault.Close()
	if _, err = fault.Exec(`UPDATE records SET data=X'00' WHERE kind='fleet-batches' AND id='batch_unreadable'`); err != nil {
		t.Fatal(err)
	}
	path := f.srv.URL + "/api/admin/fleet-batches/batch_unreadable"
	code, _, before := req(t, operatorClient(), "GET", path, "", nil)
	if code != 400 {
		t.Fatalf("damaged fixture must fail to read: %d %s", code, before)
	}
	code, rejected, raw := createFleetWithCondition(t, f, input, "*")
	if code != 412 || rejected["code"] != "FLEET_CREATION_CONFLICT" {
		t.Fatalf("unreadable occupied slot was not a creation conflict: %d %s", code, raw)
	}
	code, _, after := req(t, operatorClient(), "GET", path, "", nil)
	if code != 400 || after != before {
		t.Fatalf("guarded retry replaced damaged record: %d %s", code, after)
	}
	for _, id := range f.in.TargetIDs {
		code, state, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/agent/instances/"+id+"/state", "", nil)
		if code != 200 || state["desired"] != nil {
			t.Fatalf("conflicting create changed desired state: %d %s", code, raw)
		}
	}
}

func TestFleetGuardedCreationDoesNotTreatStoreReadFailureAsConflict(t *testing.T) {
	f := newFleetFixture(t)
	input := reviewedFleetCreation(t, f, "batch_read_failure")
	if err := f.s.Close(); err != nil {
		t.Fatal(err)
	}
	code, rejected, raw := createFleetWithCondition(t, f, input, "*")
	if code != 400 || rejected["code"] == "FLEET_CREATION_CONFLICT" {
		t.Fatalf("failed existence read must not invent an occupied slot: %d %s", code, raw)
	}
}

func TestFleetGuardedCreationRejectsPartialAndMalformedConditions(t *testing.T) {
	f := newFleetFixture(t)
	input := reviewedFleetCreation(t, f, "batch_invalid")
	for _, conditions := range [][]string{nil, {""}, {" \t "}, {`"private-etag"`}, {`W/"private-etag"`}, {"private-etag"}, {"\u00a0*\u00a0"}, {"*, *"}, {"*", "*"}, {"*", ""}} {
		code, rejected, raw := createFleetWithCondition(t, f, input, conditions...)
		if code != 400 || rejected["code"] != "FLEET_CREATION_PRECONDITION_INVALID" {
			t.Fatalf("invalid conditions %q: %d %s", conditions, code, raw)
		}
		if strings.Contains(raw, "private-etag") {
			t.Fatal("precondition error disclosed header contents")
		}
	}
	for _, id := range []any{nil, "", " bad", "bad/id", strings.Repeat("a", 65), 1, []string{"batch_invalid"}} {
		input["id"] = id
		for _, conditions := range [][]string{nil, {"*"}} {
			code, rejected, raw := createFleetWithCondition(t, f, input, conditions...)
			if code != 400 || rejected["code"] != "FLEET_CREATION_PRECONDITION_INVALID" {
				t.Fatalf("invalid id %v with conditions %q: %d %s", id, conditions, code, raw)
			}
		}
	}
	delete(input, "id")
	code, rejected, raw := createFleetWithCondition(t, f, input, "*")
	if code != 400 || rejected["code"] != "FLEET_CREATION_PRECONDITION_INVALID" {
		t.Fatalf("wildcard without ID: %d %s", code, raw)
	}
	for _, guarded := range []bool{false, true} {
		headers := http.Header{"If-Match": {"*"}}
		if guarded {
			input["id"] = "batch_invalid"
			headers.Set("If-None-Match", "*")
		}
		code, rejected, raw, err := requestFleetCreation(operatorClient(), f.srv.URL, input, headers)
		if err != nil || code != 400 || rejected["code"] != "FLEET_CREATION_PRECONDITION_INVALID" {
			t.Fatalf("unsupported If-Match: %d %s (%v)", code, raw, err)
		}
	}
	code, _, raw = req(t, operatorClient(), "GET", f.srv.URL+"/api/admin/fleet-batches", "", nil)
	if code != 200 || strings.TrimSpace(raw) != "[]" {
		t.Fatalf("invalid request created a batch: %d %s", code, raw)
	}
}

func TestFleetCreationGuardPreservesLegacyAndFreshReview(t *testing.T) {
	f := newFleetFixture(t)
	input := reviewedFleetCreation(t, f, "batch_guarded")
	code, guarded, raw := createFleetWithCondition(t, f, input, " \t*\t ")
	if code != 201 || guarded["id"] != "batch_guarded" {
		t.Fatalf("guarded creation: %d %s", code, raw)
	}
	delete(input, "id")
	code, legacy, raw := createFleetWithCondition(t, f, input)
	id, ok := legacy["id"].(string)
	if code != 201 || !ok || !strings.HasPrefix(id, "batch_") || id == "batch_guarded" {
		t.Fatalf("legacy server-generated creation: %d %s", code, raw)
	}
	if legacy["fingerprint"] != guarded["fingerprint"] || legacy["actorId"] != guarded["actorId"] {
		t.Fatal("guard changed plan identity or actor")
	}
	input["id"] = "batch_stale"
	input["expectedFingerprint"] = "stale"
	code, rejected, raw := createFleetWithCondition(t, f, input, "*")
	if code != 409 || rejected["code"] != "FLEET_REVIEW_CHANGED" {
		t.Fatalf("guard bypassed reviewed fingerprint: %d %s", code, raw)
	}
	if code, _, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/admin/fleet-batches/batch_stale", "", nil); code != 404 {
		t.Fatalf("stale review persisted: %d %s", code, raw)
	}
}

func TestFleetGuardedCreationDoesNotBypassRequestSecurity(t *testing.T) {
	f := newFleetFixture(t)
	input := reviewedFleetCreation(t, f, "batch_secure")
	user := inviteClient(t, f.s, f.srv, "fleet-create-user")
	for _, test := range []struct {
		client  *http.Client
		headers http.Header
		code    int
	}{
		{http.DefaultClient, http.Header{"If-None-Match": {"*"}}, 401},
		{user.c, http.Header{"If-None-Match": {"*"}}, 403},
		{user.c, http.Header{"If-None-Match": {"*"}, "X-Csrf-Token": {user.csrf}}, 403},
		{operatorClient(), http.Header{"If-None-Match": {"*"}, "Origin": {"https://foreign.example"}}, 403},
	} {
		code, _, raw, err := requestFleetCreation(test.client, f.srv.URL, input, test.headers)
		if err != nil || code != test.code {
			t.Fatalf("guarded request security: want %d, got %d %s (%v)", test.code, code, raw, err)
		}
	}
	input["actorId"] = "forged-actor"
	if code, _, raw := createFleetWithCondition(t, f, input, "*"); code != 400 {
		t.Fatalf("guard accepted caller-selected actor: %d %s", code, raw)
	}
	if code, _, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/admin/fleet-batches/batch_secure", "", nil); code != 404 {
		t.Fatalf("rejected request created a batch: %d %s", code, raw)
	}
}

func TestFleetGuardedCreationAcrossStoreHandlesHasOneDurableWinner(t *testing.T) {
	f := newFleetFixture(t)
	firstInput := reviewedFleetCreation(t, f, "batch_raced")
	secondInput := reviewedFleetCreation(t, f, "batch_raced")
	secondInput["leaseSeconds"] = 600
	_, second := makeServerAt(t, f.databasePath)
	type result struct {
		code  int
		value map[string]any
		raw   string
		err   error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for i, base := range []string{f.srv.URL, second.URL} {
		input := []map[string]any{firstInput, secondInput}[i]
		go func() {
			<-start
			code, value, raw, err := requestFleetCreation(operatorClient(), base, input, http.Header{"If-None-Match": {"*"}})
			results <- result{code, value, raw, err}
		}()
	}
	close(start)
	accepted, rejected := 0, 0
	var winner fleet.Batch
	for range 2 {
		outcome := <-results
		if outcome.err != nil {
			t.Fatal(outcome.err)
		}
		switch outcome.code {
		case 201:
			accepted++
			if err := json.Unmarshal([]byte(outcome.raw), &winner); err != nil {
				t.Fatal(err)
			}
		case 412:
			rejected++
			if outcome.value["code"] != "FLEET_CREATION_CONFLICT" {
				t.Fatalf("untyped occupied-ID race: %s", outcome.raw)
			}
		default:
			t.Fatalf("concurrent create: %d %s", outcome.code, outcome.raw)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("expected one winner and one conflict, got %d/%d", accepted, rejected)
	}
	_, reopened := makeServerAt(t, f.databasePath)
	for _, base := range []string{f.srv.URL, second.URL, reopened.URL} {
		if batch := requireOnlyPlannedFleetBatch(t, base, "batch_raced"); !reflect.DeepEqual(batch, winner) {
			t.Fatalf("durable winner changed: %+v", batch)
		}
	}
}
