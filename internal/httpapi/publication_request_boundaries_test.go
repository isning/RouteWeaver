package httpapi_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

func publicationBoundaryInput(t *testing.T, f fleetFixture, operationID string) (string, map[string]any) {
	t.Helper()
	url := f.srv.URL + "/api/server-deployments/" + f.in.DeploymentID
	opened := openServerDraft(t, operatorClient(), url)
	review := requireServerValidation(t, operatorClient(), url, opened["revisionToken"].(string))
	return url, map[string]any{"operationId": operationID, "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": review["fingerprint"]}
}
func publicationBoundaryDesired(t *testing.T, f fleetFixture) map[string]any {
	t.Helper()
	out := map[string]any{}
	for _, id := range f.in.TargetIDs {
		code, state, raw := req(t, operatorClient(), "GET", f.srv.URL+"/api/agent/instances/"+id+"/state", "", nil)
		if code != 200 {
			t.Fatalf("desired state %d %s", code, raw)
		}
		out[id] = state["desired"]
	}
	return out
}
func TestPublicationRequestExactIntentBindingAndSafeProjection(t *testing.T) {
	f := newFleetFixture(t)
	url, input := publicationBoundaryInput(t, f, "bound-publication")
	code, result, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
	if code != 200 || result["status"] != "publication-accepted" {
		t.Fatalf("publish %d %s", code, raw)
	}
	baseline := publicationBoundaryDesired(t, f)
	for _, field := range []string{"leaseSeconds", "accessAllowed", "quotaCertain", "expectedFingerprint", "deploymentId"} {
		t.Run(field, func(t *testing.T) {
			changed := map[string]any{}
			for k, v := range input {
				changed[k] = v
			}
			target := url
			switch field {
			case "leaseSeconds":
				changed[field] = 301
			case "accessAllowed", "quotaCertain":
				changed[field] = false
			case "expectedFingerprint":
				changed[field] = strings.Repeat("0", 64)
			case "deploymentId":
				target = f.srv.URL + "/api/server-deployments/other-deployment"
			}
			code, denied, raw := req(t, operatorClient(), "POST", target+"/publish", "", changed)
			if code != 409 || denied["code"] != "PUBLICATION_OPERATION_REUSED" {
				t.Fatalf("changed %s not refused: %d %s", field, code, raw)
			}
			if !reflect.DeepEqual(baseline, publicationBoundaryDesired(t, f)) {
				t.Fatal("identity misuse changed current desired")
			}
		})
	}
	code, lookup, raw := req(t, operatorClient(), "GET", url+"/publication-requests/bound-publication", "", nil)
	if code != 200 || !reflect.DeepEqual(lookup["result"], result) {
		t.Fatalf("lookup %d %s", code, raw)
	}
	if len(lookup) != 2 {
		t.Fatalf("unexpected receipt fields: %s", raw)
	}
	request, ok := lookup["request"].(map[string]any)
	if !ok || len(request) != 4 || request["leaseSeconds"] != float64(300) || request["accessAllowed"] != true || request["quotaCertain"] != true || request["expectedFingerprint"] != input["expectedFingerprint"] {
		t.Fatalf("request projection mismatch: %s", raw)
	}
	for _, secret := range []string{"fixture-password", "fixture-user", "requestToken", "artifacts", "\"digest\"", "\"ir\"", "\"actor\""} {
		if strings.Contains(raw, secret) {
			t.Fatalf("private receipt field leaked: %s", secret)
		}
	}
	for _, entry := range result["instances"].([]any) {
		target := entry.(map[string]any)
		if len(target) != 4 || target["generation"] != "1" || target["instanceId"] == nil || target["revisionId"] == nil || target["operationId"] == nil {
			t.Fatalf("unsafe target projection: %v", target)
		}
	}
}

func TestPublicationRequestCurrentPermissionAndActorScope(t *testing.T) {
	f := newFleetFixture(t)
	// Bootstrap the local administrator before creating any invited accounts.
	if err := f.s.EnsureAdmin("publication-admin", "synthetic-admin-password"); err != nil {
		t.Fatal(err)
	}
	url, input := publicationBoundaryInput(t, f, "actor-publication")
	code, accepted, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
	if code != 200 || accepted["status"] != "publication-accepted" {
		t.Fatalf("publish %d %s", code, raw)
	}
	baseline := publicationBoundaryDesired(t, f)
	regular := inviteClient(t, f.s, f.srv, "publication-reader")
	for _, method := range []string{"GET", "POST"} {
		path := url + "/publication-requests/actor-publication"
		var body any
		if method == "POST" {
			path = url + "/publish"
			body = input
		}
		code, _, raw := req(t, regular.c, method, path, regular.csrf, body)
		if code != 403 {
			t.Fatalf("regular user %s permission: %d %s", method, code, raw)
		}
	}
	// A separate verified administrator is a different receipt actor, not the
	// bearer operator. Public login establishes its current permission.
	jar, _ := cookiejar.New(nil)
	other := &http.Client{Jar: jar}
	code, login, raw := req(t, other, "POST", f.srv.URL+"/api/auth/login", "", map[string]string{"username": "publication-admin", "password": "synthetic-admin-password"})
	if code != 200 {
		t.Fatalf("admin login %d %s", code, raw)
	}
	code, _, raw = req(t, other, "GET", url+"/publication-requests/actor-publication", "", nil)
	if code != 404 || strings.Contains(raw, "publication-accepted") || strings.Contains(raw, "expectedFingerprint") {
		t.Fatalf("cross-actor receipt disclosure %d %s", code, raw)
	}
	// Permission is checked at lookup time, not inherited from a saved handle.
	id := login["user"].(map[string]any)["id"].(string)
	var account store.Account
	if err := f.s.Get("accounts", id, &account); err != nil {
		t.Fatal(err)
	}
	account.Role = "user"
	if err := f.s.Put("accounts", id, account); err != nil {
		t.Fatal(err)
	}
	code, _, raw = req(t, other, "GET", url+"/publication-requests/actor-publication", "", nil)
	if code != 403 {
		t.Fatalf("removed admin permission retained receipt access: %d %s", code, raw)
	}
	if !reflect.DeepEqual(baseline, publicationBoundaryDesired(t, f)) {
		t.Fatal("lookup/authorization changed desired")
	}
}

func TestPublicationRequestDependencyDecodeFailureRemainsRecoverable(t *testing.T) {
	f := newFleetFixture(t)
	url, input := publicationBoundaryInput(t, f, "recover-dependency")
	var saved json.RawMessage
	id := f.in.TargetIDs[0]
	if err := f.s.Get("core-instances", id, &saved); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Put("core-instances", id, map[string]any{"id": id, "hostId": map[string]any{"private": "operational-secret-marker"}}); err != nil {
		t.Fatal(err)
	}
	code, out, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
	if code != 503 || out["status"] != nil || strings.Contains(raw, "operational-secret-marker") {
		t.Fatalf("dependency read became terminal/private: %d %s", code, raw)
	}
	code, _, raw = req(t, operatorClient(), "GET", url+"/publication-requests/recover-dependency", "", nil)
	if code != 404 {
		t.Fatalf("operational error wrote receipt: %d %s", code, raw)
	}
	for _, desired := range publicationBoundaryDesired(t, f) {
		if desired != nil {
			t.Fatal("operational error queued desired")
		}
	}
	if err := f.s.Put("core-instances", id, saved); err != nil {
		t.Fatal(err)
	}
	code, out, raw = req(t, operatorClient(), "POST", url+"/publish", "", input)
	if code != 200 || out["status"] != "publication-accepted" {
		t.Fatalf("same operation could not recover after repair: %d %s", code, raw)
	}
	for _, target := range out["instances"].([]any) {
		if target.(map[string]any)["generation"] != "1" {
			t.Fatal("failed attempt consumed generation")
		}
	}
}

func TestPublicationRequestRejectedReceiptSurvivesStoreRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "publication.db")
	key := bytes.Repeat([]byte{27}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(httpapi.New(s, render.Default(), "012345678901234567890123456789012345", ""))
	input := map[string]any{"operationId": "restart-rejection", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": strings.Repeat("0", 64)}
	code, before, raw := req(t, operatorClient(), "POST", srv.URL+"/api/server-deployments/missing/publish", "", input)
	if code != 200 || before["status"] != "definitively-rejected" || before["code"] != "PUBLICATION_REJECTED" {
		srv.Close()
		s.Close()
		t.Fatalf("initial refusal %d %s", code, raw)
	}
	srv.Close()
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restarted := httptest.NewServer(httpapi.New(reopened, render.Default(), "012345678901234567890123456789012345", ""))
	defer restarted.Close()
	url := restarted.URL + "/api/server-deployments/missing"
	code, lookup, raw := req(t, operatorClient(), "GET", url+"/publication-requests/restart-rejection", "", nil)
	if code != 200 || !reflect.DeepEqual(lookup["result"], before) {
		t.Fatalf("durable receipt lookup %d %s", code, raw)
	}
	code, replayed, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
	if code != 200 || !reflect.DeepEqual(replayed, before) {
		t.Fatalf("durable replay changed result %d %s", code, raw)
	}
}

func TestPublicationRequestRequiresExplicitBooleanAcknowledgements(t *testing.T) {
	for _, field := range []string{"accessAllowed", "quotaCertain"} {
		for _, shape := range []string{"missing", "null", "string"} {
			t.Run(field+"-"+shape, func(t *testing.T) {
				f := newFleetFixture(t)
				url, input := publicationBoundaryInput(t, f, "explicit-ack")
				switch shape {
				case "missing":
					delete(input, field)
				case "null":
					input[field] = nil
				case "string":
					input[field] = "false"
				}
				code, result, raw := req(t, operatorClient(), "POST", url+"/publish", "", input)
				if code != 400 || result["status"] != nil {
					t.Fatalf("implicit ack accepted: %d %s", code, raw)
				}
				code, _, raw = req(t, operatorClient(), "GET", url+"/publication-requests/explicit-ack", "", nil)
				if code != 404 {
					t.Fatalf("invalid envelope claimed receipt: %d %s", code, raw)
				}
				for _, desired := range publicationBoundaryDesired(t, f) {
					if desired != nil {
						t.Fatal("invalid envelope queued desired")
					}
				}
				// false is a valid explicit policy value, not missing authorization input.
				input[field] = false
				code, result, raw = req(t, operatorClient(), "POST", url+"/publish", "", input)
				if code != 200 || result["status"] != "publication-accepted" {
					t.Fatalf("explicit false could not use unclaimed operation: %d %s", code, raw)
				}
				code, lookup, raw := req(t, operatorClient(), "GET", url+"/publication-requests/explicit-ack", "", nil)
				if code != 200 || lookup["request"].(map[string]any)[field] != false {
					t.Fatalf("explicit false was normalized: %d %s", code, raw)
				}
			})
		}
	}
}
