package httpapi_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"reflect"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"sync"
	"testing"
	"time"
)

func newRetargetFixture(t *testing.T) (*store.Store, *httptest.Server, httpapi.ServerDeployment, domain.ManagedEndpoint, domain.ManagedEndpoint) {
	s, srv := makeServer(t)
	entry := domain.ManagedEndpoint{ID: "fra", Name: "FRA", InstanceID: "fra-core", Authentication: "principals", Connection: domain.Connection{Protocol: "vless", Host: "0.0.0.0", Port: 1080}}
	old := domain.ManagedEndpoint{ID: "uk", Name: "Old UK", InstanceID: "uk-core", Connection: domain.Connection{Protocol: "vless", Host: "10.0.0.2", Port: 1080, UUID: "11111111-1111-4111-8111-111111111111"}}
	next := domain.ManagedEndpoint{ID: "new-uk", Name: "New UK", InstanceID: "new-core", Connection: domain.Connection{Protocol: "vless", Host: "10.0.0.3", Port: 1080, UUID: "22222222-2222-4222-8222-222222222222"}}
	programs := []domain.ServerProgram{}
	for i, e := range []domain.ManagedEndpoint{entry, old, next} {
		instance := domain.CoreInstance{ID: e.InstanceID, HostID: e.ID + "-host", AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}
		if i == 0 {
			instance.AdapterID = render.ServerAdapterManagedXray
			instance.Version = render.ManagedXrayVersion
		}
		if err := s.Put("hosts", instance.HostID, domain.Host{ID: instance.HostID, Name: e.Name, Address: e.Connection.Host}); err != nil {
			t.Fatal(err)
		}
		if err := s.Put("core-instances", instance.ID, instance); err != nil {
			t.Fatal(err)
		}
		if err := s.Put("managed-endpoints", e.ID, e); err != nil {
			t.Fatal(err)
		}
		if i < 2 {
			programs = append(programs, domain.ServerProgram{Instance: instance, Listener: e})
		}
	}
	programs[0].Egress = []domain.Connection{old.Connection}
	programs[0].Principals = []domain.ServerPrincipal{{SubjectID: "subject", AccountID: "alice", RouteID: "route", CredentialVersion: "v1", Credential: domain.PrincipalCredential{UUID: "33333333-3333-4333-8333-333333333333"}, Action: domain.ActionRef{Kind: "forward", Ref: "egress-1"}, PolicyRevision: "meter-original", CycleID: "cycle"}}
	deployment := httpapi.ServerDeployment{ID: "deployment", Name: "FRA UK", Status: "draft", IR: domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "deployment", TopologyRevision: "original", Programs: programs}}
	if err := s.Put("server-deployments", deployment.ID, deployment); err != nil {
		t.Fatal(err)
	}
	route := domain.PublishedRoute{ID: "route", Name: "My route", DeploymentID: deployment.ID, EndpointIDs: []string{"fra", "uk"}, Path: domain.RoutePath{ID: "route", Entry: "fra", Exit: "uk"}, PublicHost: "10.0.0.1", PublicPort: 1080}
	if err := s.Put("published-routes", route.ID, route); err != nil {
		t.Fatal(err)
	}
	return s, srv, deployment, old, next
}

func TestManagedRouteRetargetAddsInventoryExitPreservesFallbackAndReplaysReceipt(t *testing.T) {
	s, srv, deployment, old, next := newRetargetFixture(t)
	_ = s
	programs := deployment.IR.Programs
	_, rv, _ := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/route/resolve", "", nil)
	_, dv, _ := req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/deployment", "", nil)
	input := map[string]any{"replacementEndpointId": "new-uk", "expectedRouteRevision": rv["revisionToken"], "expectedDeploymentRevision": dv["revisionToken"]}
	code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 || preview["addedProgram"] != true || preview["legacyNormalized"] != true {
		t.Fatalf("preview %d %s", code, raw)
	}
	if strings.Contains(raw, "33333333") || strings.Contains(raw, "22222222") || strings.Contains(raw, "connectors") {
		t.Fatal("private intent leaked")
	}
	var unchanged httpapi.ServerDeployment
	_, _, unchangedRaw := req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/"+deployment.ID+"/reveal", "", nil)
	json.Unmarshal([]byte(unchangedRaw), &unchanged)
	if !reflect.DeepEqual(unchanged.IR, deployment.IR) {
		t.Fatal("preview mutated")
	}
	input["reviewToken"] = preview["reviewToken"]
	input["operationId"] = "retarget-one"
	var group sync.WaitGroup
	type reply struct {
		code int
		body string
		err  error
	}
	replies := make(chan reply, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			body, _ := json.Marshal(input)
			r, _ := http.NewRequest("POST", srv.URL+"/api/published-routes/route/retarget", bytes.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			response, err := operatorClient().Do(r)
			if err != nil {
				replies <- reply{err: err}
				return
			}
			raw, _ := io.ReadAll(response.Body)
			response.Body.Close()
			replies <- reply{code: response.StatusCode, body: string(raw)}
		}()
	}
	group.Wait()
	close(replies)
	for reply := range replies {
		if reply.err != nil || reply.code != 200 {
			t.Fatalf("concurrent retry %d %s %v", reply.code, reply.body, reply.err)
		}
	}
	code, result, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
	if code != 200 {
		t.Fatalf("save %d %s", code, raw)
	}
	code, replay, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
	if code != 200 || !reflect.DeepEqual(result, replay) {
		t.Fatalf("receipt replay %d %s", code, raw)
	}
	var after httpapi.ServerDeployment
	_, _, afterRaw := req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/"+deployment.ID+"/reveal", "", nil)
	json.Unmarshal([]byte(afterRaw), &after)
	p := after.IR.Programs[0]
	if len(after.IR.Programs) != 3 || len(p.Connectors) != 2 || p.DefaultAction != (domain.ActionRef{Kind: "forward", Ref: "egress-1"}) || !reflect.DeepEqual(p.Connectors[0].Connection, old.Connection) || !reflect.DeepEqual(p.Connectors[1].Connection, next.Connection) {
		t.Fatal("real forwarding/default incorrect")
	}
	principal := p.Principals[0]
	principal.Action = programs[0].Principals[0].Action
	if !reflect.DeepEqual(principal, programs[0].Principals[0]) {
		t.Fatal("principal accounting or credential changed")
	}
	// A previously opened editor cannot overwrite the coherent mutation.
	body, _ := json.Marshal(deployment)
	r, _ := http.NewRequest("PUT", srv.URL+"/api/server-deployments/deployment", bytes.NewReader(body))
	r.Header.Set("If-Match", dv["revisionToken"].(string))
	r.Header.Set("Content-Type", "application/json")
	response, e := operatorClient().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 409 {
		t.Fatalf("stale writer %d", response.StatusCode)
	}
	code, _, raw = putAdminRecord(t, operatorClient(), srv.URL+"/api/published-routes/route", rv["revisionToken"].(string), map[string]any{"id": "route", "name": "Stale route editor", "deploymentId": "deployment", "endpointIds": []string{"fra", "uk"}, "publicHost": "10.0.0.1", "publicPort": 1080})
	if code != 409 {
		t.Fatalf("stale published-route writer %d %s", code, raw)
	}
	input["replacementEndpointId"] = "uk"
	code, _, _ = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
	if code != 409 {
		t.Fatal("operation reused with different input")
	}
}

func retargetInput(t *testing.T, srv *httptest.Server) map[string]any {
	t.Helper()
	_, route, _ := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/route/resolve", "", nil)
	_, deployment, _ := req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/deployment", "", nil)
	return map[string]any{"replacementEndpointId": "new-uk", "expectedRouteRevision": route["revisionToken"], "expectedDeploymentRevision": deployment["revisionToken"]}
}

func TestManagedRouteRetargetRejectsUnsupportedTargetsWithoutPrivateErrors(t *testing.T) {
	for _, kind := range []string{"principal-transit", "tls-unpaired-path", "unknown-stored-field", "unknown-verification-flag", "conditional-ingress", "occupied-core"} {
		t.Run(kind, func(t *testing.T) {
			s, srv, deployment, _, next := newRetargetFixture(t)
			input := map[string]any{}
			switch kind {
			case "principal-transit":
				next.Authentication = "principals"
				next.Connection.UUID = ""
				s.Put("managed-endpoints", next.ID, next)
			case "tls-unpaired-path":
				next.Connection.TLS = &domain.TLSOptions{Enabled: true, ServerName: "target.example.invalid"}
				s.Put("managed-endpoints", next.ID, next)
				input["tls"] = map[string]any{"certificatePath": "tls/cert.pem"}
			case "unknown-stored-field":
				raw, _ := json.Marshal(deployment)
				var record map[string]any
				json.Unmarshal(raw, &record)
				record["futureSecretPolicy"] = "not-for-review"
				s.Put("server-deployments", deployment.ID, record)
			case "unknown-verification-flag":
				raw, _ := json.Marshal(next)
				var record map[string]any
				json.Unmarshal(raw, &record)
				record["connection"].(map[string]any)["tls"] = map[string]any{"enabled": true, "insecure": true}
				s.Put("managed-endpoints", next.ID, record)
			case "conditional-ingress":
				deployment.IR.Programs[0].Rules = []domain.PolicyRule{{ID: "special", Match: domain.MatchExpression{Op: "domain", Value: "private.example.invalid"}, Action: domain.ActionRef{Kind: "reject"}}}
				s.Put("server-deployments", deployment.ID, deployment)
			case "occupied-core":
				next.InstanceID = "uk-core"
				s.Put("managed-endpoints", next.ID, next)
			}
			for key, value := range retargetInput(t, srv) {
				input[key] = value
			}
			_, _, before := req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/deployment/reveal", "", nil)
			code, _, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
			if code != 422 {
				t.Fatalf("%s status %d %s", kind, code, raw)
			}
			for _, secret := range []string{"11111111", "22222222", "33333333", "not-for-review", "tls/private.pem", "private.example.invalid"} {
				if strings.Contains(raw, secret) {
					t.Fatalf("private error %s", raw)
				}
			}
			_, _, after := req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/deployment/reveal", "", nil)
			if before != after {
				t.Fatal("refusal changed draft")
			}
		})
	}
}

func TestManagedRouteRetargetRejectsNewDependencyAndInventoryDriftAfterReview(t *testing.T) {
	for _, kind := range []string{"new-route", "target-drift"} {
		t.Run(kind, func(t *testing.T) {
			s, srv, _, _, next := newRetargetFixture(t)
			input := retargetInput(t, srv)
			code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
			if code != 200 {
				t.Fatalf("preview %d %s", code, raw)
			}
			input["reviewToken"] = preview["reviewToken"]
			input["operationId"] = "new-dependent"
			if kind == "new-route" {
				s.Put("published-routes", "new-related", domain.PublishedRoute{ID: "new-related", Name: "Additional route", DeploymentID: "deployment", EndpointIDs: []string{"fra", "uk"}, Path: domain.RoutePath{ID: "new-related", Entry: "fra", Exit: "uk"}, PublicHost: "10.0.0.1", PublicPort: 1080})
			} else {
				next.Connection.Port = 1081
				s.Put("managed-endpoints", next.ID, next)
			}
			_, _, before := req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/deployment/reveal", "", nil)
			code, _, raw = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
			if code != 200 || !strings.Contains(raw, `"status":"draft-rejected"`) {
				t.Fatalf("stale review rejection receipt %d %s", code, raw)
			}
			_, _, after := req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/deployment/reveal", "", nil)
			if before != after {
				t.Fatal("conflict mutated deployment")
			}
		})
	}
}

func TestManagedRouteRetargetRequiresAdministratorAndCreateDoesNotOverwrite(t *testing.T) {
	s, srv, deployment, _, _ := newRetargetFixture(t)
	user := inviteClient(t, s, srv, "retarget-tenant")
	input := retargetInput(t, srv)
	for _, suffix := range []string{"/preview", ""} {
		code, _, raw := req(t, user.c, "POST", srv.URL+"/api/published-routes/route/retarget"+suffix, user.csrf, input)
		if code != 403 || strings.Contains(raw, "My route") {
			t.Fatalf("tenant access %d %s", code, raw)
		}
	}
	deployment.Name = "Unreviewed overwrite"
	if code, _, raw := req(t, operatorClient(), "POST", srv.URL+"/api/server-deployments", "", deployment); code != 409 {
		t.Fatalf("create overwrote existing %d %s", code, raw)
	}
	if code, _, raw := req(t, operatorClient(), "PUT", srv.URL+"/api/server-deployments/deployment", "", deployment); code != 409 {
		t.Fatalf("unguarded update %d %s", code, raw)
	}
}

func TestManagedRouteRetargetPathOnlyTLSIsExplicitlyBlockedForApplication(t *testing.T) {
	s, srv, _, _, next := newRetargetFixture(t)
	next.Connection.TLS = &domain.TLSOptions{Enabled: true, ServerName: "target.example.invalid"}
	if err := s.Put("managed-endpoints", next.ID, next); err != nil {
		t.Fatal(err)
	}
	input := retargetInput(t, srv)
	input["tls"] = map[string]any{"certificatePath": "tls/cert.pem", "keyPath": "tls/key.pem"}
	code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 {
		t.Fatalf("draft preview %d %s", code, raw)
	}
	readiness := preview["applicationReadiness"].(map[string]any)
	if readiness["state"] != "blocked" || readiness["code"] != "tls-material-required" || preview["nativeChecked"] != false {
		t.Fatalf("missing material hidden %s", raw)
	}
	if preview["after"].(map[string]any)["tlsMaterial"] != "paths-only" {
		t.Fatal("path intent mislabeled")
	}
	input["reviewToken"] = preview["reviewToken"]
	input["operationId"] = "path-only-draft"
	code, _, raw = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
	if code != 200 {
		t.Fatalf("explicit draft save %d %s", code, raw)
	}
}

// Simulated recorded observations only: this fixture performs no native apply
// and proves only that the HTTP resolver keeps the immutable prior path.
func recordOldRetargetObservations(t *testing.T, s *store.Store, srv *httptest.Server, deployment httpapi.ServerDeployment) {
	t.Helper()
	opened := openServerDraft(t, operatorClient(), srv.URL+"/api/server-deployments/deployment")
	code, validated, raw := validateOpenedServer(t, operatorClient(), srv.URL+"/api/server-deployments/deployment", opened["revisionToken"].(string))
	if code != 200 || validated["valid"] != true {
		t.Fatalf("fixture config %d %s", code, raw)
	}
	var route domain.PublishedRoute
	if e := s.Get("published-routes", "route", &route); e != nil {
		t.Fatal(e)
	}
	for _, p := range deployment.IR.Programs {
		scope := controlprotocol.Scope{NodeID: p.Instance.HostID, InstanceID: p.Instance.ID, EnrollmentEpoch: "enrollment"}
		desired := controlprotocol.Desired{Scope: scope, AdapterID: p.Instance.AdapterID, CoreVersion: p.Instance.Version, Generation: 1, RevisionID: "rev_" + p.Instance.ID, OperationID: "op_" + p.Instance.ID, Digest: "synthetic-artifact-digest"}
		identity := desired.Identity()
		state := controlprotocol.State{HighestAccepted: 1, Desired: &identity, Phase: controlprotocol.ObservedConformant, NativeChecked: true, Observed: &controlprotocol.Observation{Identity: identity, Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}}
		rawIdentity, _ := json.Marshal(identity)
		var domainIdentity domain.DeploymentIdentity
		json.Unmarshal(rawIdentity, &domainIdentity)
		manifest := domain.PublishedManifest{PolicyExpiresAt: time.Now().Add(time.Hour), DeploymentID: deployment.ID, Fingerprint: validated["fingerprint"].(string), Identity: domainIdentity, Program: p, Routes: []domain.PublishedRoute{route}}
		for _, record := range []struct {
			kind, id string
			value    any
		}{{"agent-desired", p.Instance.ID, desired}, {"agent-observations", p.Instance.ID, state}, {"published-manifests", desired.RevisionID, manifest}, {"instance-enrollments", p.Instance.ID, httpapi.Enrollment{Scope: scope, ExpiresAt: time.Now().Add(time.Hour)}}} {
			if e := s.Put(record.kind, record.id, record.value); e != nil {
				t.Fatal(e)
			}
		}
	}
}

func TestManagedRouteRetargetHeartbeatDoesNotInvalidateReviewAndOldPathRemainsObserved(t *testing.T) {
	s, srv, deployment, _, _ := newRetargetFixture(t)
	recordOldRetargetObservations(t, s, srv, deployment)
	input := retargetInput(t, srv)
	code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 {
		t.Fatalf("preview %d %s", code, raw)
	}
	var state controlprotocol.State
	s.Get("agent-observations", "fra-core", &state)
	state.Observed.ObservedAt = state.Observed.ObservedAt.Add(time.Second)
	state.Observed.Evidence = "same identity refreshed"
	s.Put("agent-observations", "fra-core", state)
	input["reviewToken"] = preview["reviewToken"]
	input["operationId"] = "heartbeat-retarget"
	code, _, raw = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
	if code != 200 {
		t.Fatalf("harmless observation invalidated review %d %s", code, raw)
	}
	code, resolved, raw := req(t, operatorClient(), "GET", srv.URL+"/api/published-routes/route/resolve", "", nil)
	if code != 200 || resolved["status"] != "effective" || resolved["pendingChanges"] != true {
		t.Fatalf("frozen path lost %d %s", code, raw)
	}
	effective := resolved["effective"].(map[string]any)
	if !reflect.DeepEqual(effective["endpointIds"], []any{"fra", "uk"}) || !reflect.DeepEqual(resolved["endpointIds"], []any{"fra", "new-uk"}) {
		t.Fatalf("draft represented as applied %s", raw)
	}
}

func TestManagedRouteRetargetRechecksActivationAndRecoveryAtCommit(t *testing.T) {
	for _, kind := range []string{"recovery", "not-native-checked", "applying"} {
		t.Run(kind, func(t *testing.T) {
			s, srv, deployment, _, _ := newRetargetFixture(t)
			recordOldRetargetObservations(t, s, srv, deployment)
			input := retargetInput(t, srv)
			code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
			if code != 200 {
				t.Fatalf("preview %d %s", code, raw)
			}
			var state controlprotocol.State
			s.Get("agent-observations", "fra-core", &state)
			switch kind {
			case "recovery":
				state.RecoveryRequired = true
			case "not-native-checked":
				state.NativeChecked = false
			case "applying":
				state.Phase = controlprotocol.Applying
			}
			s.Put("agent-observations", "fra-core", state)
			input["reviewToken"] = preview["reviewToken"]
			input["operationId"] = "activation-retarget"
			code, _, raw = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
			if code != 200 || !strings.Contains(raw, `"status":"draft-rejected"`) {
				t.Fatalf("unsafe activation rejection receipt %d %s", code, raw)
			}
		})
	}
}

func TestManagedRouteRetargetKeepsAccountingBindingWithoutNewBoundary(t *testing.T) {
	s, srv, _, _, _ := newRetargetFixture(t)
	if err := s.PutUser(domain.User{ID: "alice", Name: "Alice", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	binding := store.MeterBinding{ID: "subject", InstanceID: "fra-core", SubjectID: "subject", UserID: "alice", RouteID: "route", PolicyRevision: "meter-original", CycleID: "cycle", MeasurementLayer: "entry_payload"}
	if err := s.SetMeterBinding(binding); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	sample := store.CounterSample{SampleID: "zero", CounterEpoch: "epoch", SubjectID: "subject", RouteID: "route", PolicyRevision: "meter-original", CycleID: "cycle", MeasurementLayer: "entry_payload", CumulativeBytes: 0, ObservedAt: now.Add(-time.Minute)}
	baseline := store.CounterBatch{InstanceID: "fra-core", EnrollmentEpoch: "enrollment", StreamEpoch: "stream", Sequence: 1, Digest: "zero", Samples: []store.CounterSample{sample}}
	if err := s.AcceptCounterBatch(baseline, baseline); err != nil {
		t.Fatal(err)
	}
	input := retargetInput(t, srv)
	code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 {
		t.Fatalf("preview %d %s", code, raw)
	}
	input["reviewToken"] = preview["reviewToken"]
	input["operationId"] = "accounting-retarget"
	code, _, raw = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
	if code != 200 {
		t.Fatalf("save %d %s", code, raw)
	}
	_, _, raw = req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/deployment/reveal", "", nil)
	var changed httpapi.ServerDeployment
	json.Unmarshal([]byte(raw), &changed)
	principal := changed.IR.Programs[0].Principals[0]
	sample.SampleID = "after"
	sample.PolicyRevision = principal.PolicyRevision
	sample.CycleID = principal.CycleID
	sample.CumulativeBytes = 100
	sample.ObservedAt = now
	batch := baseline
	batch.Sequence = 2
	batch.Digest = "after"
	batch.Samples = []store.CounterSample{sample}
	if err := s.AcceptCounterBatch(batch, batch); err != nil {
		t.Fatalf("retarget introduced accounting boundary: %v", err)
	}
	hold, err := s.HasAccountingHold("alice")
	if err != nil || hold {
		t.Fatalf("retarget caused eligibility hold: %v %v", hold, err)
	}
	usage, err := s.Usage("alice", time.Time{}, now.Add(time.Hour))
	if err != nil || usage.RawBytes != 100 {
		t.Fatalf("accounting changed: %+v %v", usage, err)
	}
}

func TestManagedRouteRetargetReceiptCannotBeReplayedByAnotherAdministrator(t *testing.T) {
	s, srv, _, _, _ := newRetargetFixture(t)
	input := retargetInput(t, srv)
	code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 {
		t.Fatalf("preview %d %s", code, raw)
	}
	input["reviewToken"] = preview["reviewToken"]
	input["operationId"] = "private-receipt"
	code, _, raw = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
	if code != 200 {
		t.Fatalf("save %d %s", code, raw)
	}
	_, token, err := s.CreateInvite("Other admin", "admin", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	code, session, raw := req(t, client, "POST", srv.URL+"/api/auth/accept-invite", "", map[string]string{"token": token, "username": "other-admin", "password": "synthetic-admin-password"})
	if code != 200 {
		t.Fatalf("admin fixture %d %s", code, raw)
	}
	code, _, raw = req(t, client, "POST", srv.URL+"/api/published-routes/route/retarget", session["csrfToken"].(string), input)
	if code != 200 || !strings.Contains(raw, `"status":"draft-rejected"`) || strings.Contains(raw, "draft-saved") || strings.Contains(raw, "routeRevision") {
		t.Fatalf("cross actor receipt leaked %d %s", code, raw)
	}
}

// Local ephemeral test material only, never used outside this synthetic server.
func TestManagedRouteRetargetAcceptsPairedTLSMaterialWithoutLeakingIt(t *testing.T) {
	s, srv, _, _, next := newRetargetFixture(t)
	next.Connection.TLS = &domain.TLSOptions{Enabled: true, ServerName: "target.example.invalid"}
	if err := s.Put("managed-endpoints", next.ID, next); err != nil {
		t.Fatal(err)
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"target.example.invalid"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	material := domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}))}
	input := retargetInput(t, srv)
	input["tls"] = material
	code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 {
		t.Fatalf("paired TLS preview %d %s", code, raw)
	}
	if preview["applicationReadiness"].(map[string]any)["state"] != "requires-apply-check" || preview["after"].(map[string]any)["tlsMaterial"] != "provided" || preview["nativeChecked"] != false {
		t.Fatalf("wrong evidence strength %s", raw)
	}
	if strings.Contains(raw, "BEGIN") || strings.Contains(raw, "tls/cert.pem") || strings.Contains(raw, "22222222") {
		t.Fatal("review exposed private material")
	}
	input["reviewToken"] = preview["reviewToken"]
	input["operationId"] = "paired-tls"
	code, _, raw = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
	if code != 200 {
		t.Fatalf("paired TLS draft %d %s", code, raw)
	}
	var saved httpapi.ServerDeployment
	_, _, raw = req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/deployment/reveal", "", nil)
	if err := json.Unmarshal([]byte(raw), &saved); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(saved.IR.Programs[len(saved.IR.Programs)-1].TLS, &material) {
		t.Fatal("explicit TLS intent changed")
	}
}

func TestManagedRouteRetargetShowsSameModeSecurityChanges(t *testing.T) {
	s, srv, deployment, old, next := newRetargetFixture(t)
	old.Connection.TLS = &domain.TLSOptions{Enabled: true, ServerName: "old.example.invalid", ALPN: []string{"h2"}}
	next.Connection.TLS = &domain.TLSOptions{Enabled: true, ServerName: "new.example.invalid", ALPN: []string{"http/1.1"}}
	deployment.IR.Programs[0].Egress[0] = old.Connection
	deployment.IR.Programs[1].Listener = old
	deployment.IR.Programs[1].TLS = &domain.ServerTLSOptions{CertificatePath: "tls/old-cert.pem", KeyPath: "tls/old-key.pem"}
	for _, record := range []struct {
		kind, id string
		value    any
	}{{"managed-endpoints", old.ID, old}, {"managed-endpoints", next.ID, next}, {"server-deployments", deployment.ID, deployment}} {
		if err := s.Put(record.kind, record.id, record.value); err != nil {
			t.Fatal(err)
		}
	}
	input := retargetInput(t, srv)
	input["tls"] = domain.ServerTLSOptions{CertificatePath: "tls/new-cert.pem", KeyPath: "tls/new-key.pem"}
	code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 {
		t.Fatalf("TLS review %d %s", code, raw)
	}
	changes := preview["securityChanges"].([]any)
	if !reflect.DeepEqual(changes, []any{"server-name-changed", "tls-options-changed"}) {
		t.Fatalf("same-mode security changes hidden: %v", changes)
	}
	if strings.Contains(raw, "old.example.invalid") || strings.Contains(raw, "new.example.invalid") {
		t.Fatal("raw TLS configuration in review")
	}
}

func TestManagedRouteRetargetUsesOpenedRawRecordRevision(t *testing.T) {
	s, srv, deployment, _, _ := newRetargetFixture(t)
	raw, _ := json.Marshal(deployment)
	var stored map[string]any
	json.Unmarshal(raw, &stored)
	delete(stored, "diagnostics")
	delete(stored, "updatedAt")
	if err := s.Put("server-deployments", deployment.ID, stored); err != nil {
		t.Fatal(err)
	}
	var route map[string]any
	if err := s.Get("published-routes", "route", &route); err != nil {
		t.Fatal(err)
	}
	delete(route["path"].(map[string]any), "links")
	if err := s.Put("published-routes", "route", route); err != nil {
		t.Fatal(err)
	}
	input := retargetInput(t, srv)
	code, _, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 {
		t.Fatalf("supported historic omissions must not produce stale revision: %d %s", code, body)
	}
}

func TestManagedRouteRetargetLostRejectionResponseIsDurableAndNeverLaterSaves(t *testing.T) {
	s, srv, _, _, next := newRetargetFixture(t)
	input := retargetInput(t, srv)
	code, preview, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
	if code != 200 {
		t.Fatalf("preview %d %s", code, raw)
	}
	input["reviewToken"] = preview["reviewToken"]
	input["operationId"] = "lost-rejection"
	// Hold an original HTTP request mid-body while a retry claims a rejection.
	// No production hook: the original transport exists before the tombstone.
	originalBody, _ := json.Marshal(input)
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	originalResult := make(chan string, 1)
	go func() {
		request, _ := http.NewRequest("POST", srv.URL+"/api/published-routes/route/retarget", reader)
		request.Header.Set("Content-Type", "application/json")
		response, err := operatorClient().Do(request)
		if err != nil {
			originalResult <- err.Error()
			return
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		originalResult <- string(body)
	}()
	midpoint := len(originalBody) / 2
	if _, err := writer.Write(originalBody[:midpoint]); err != nil {
		t.Fatal(err)
	}
	drifted := next
	drifted.Connection.Port++
	if err := s.Put("managed-endpoints", next.ID, drifted); err != nil {
		t.Fatal(err)
	}
	// The request reaches the server, but the simulated caller loses its response.
	code, rejected, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
	if code != 200 || rejected["status"] != "draft-rejected" || rejected["operationId"] != "lost-rejection" || rejected["routeId"] != "route" {
		t.Fatalf("no authoritative rejection receipt: %d %s", code, raw)
	}
	// Restore the original review inputs: a persisted rejection must still prevent
	// an original in-flight writer or later replay from ever saving this operation.
	if err := s.Put("managed-endpoints", next.ID, next); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(originalBody[midpoint:]); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	var originalOutcome map[string]any
	originalResponse := <-originalResult
	if json.Unmarshal([]byte(originalResponse), &originalOutcome) != nil || !reflect.DeepEqual(originalOutcome, rejected) {
		t.Fatalf("original in-flight request escaped rejection: %s", originalResponse)
	}
	var group sync.WaitGroup
	responses := make(chan string, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			body, _ := json.Marshal(input)
			request, _ := http.NewRequest("POST", srv.URL+"/api/published-routes/route/retarget", bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response, err := operatorClient().Do(request)
			if err != nil {
				responses <- err.Error()
				return
			}
			defer response.Body.Close()
			body, _ = io.ReadAll(response.Body)
			responses <- string(body)
		}()
	}
	group.Wait()
	close(responses)
	for body := range responses {
		var outcome map[string]any
		if json.Unmarshal([]byte(body), &outcome) != nil || !reflect.DeepEqual(outcome, rejected) {
			t.Fatalf("rejected operation changed outcome: %s", body)
		}
	}
	_, _, raw = req(t, operatorClient(), "GET", srv.URL+"/api/server-deployments/deployment/reveal", "", nil)
	var saved httpapi.ServerDeployment
	json.Unmarshal([]byte(raw), &saved)
	if len(saved.IR.Programs) != 2 || saved.IR.Programs[0].Principals[0].Action.Ref != "egress-1" {
		t.Fatal("rejected receipt allowed a later draft write")
	}
}

func TestManagedRouteRetargetScopesUnsupportedRouteFieldsToRelatedDeployment(t *testing.T) {
	for _, related := range []bool{false, true} {
		name := "unrelated"
		if related {
			name = "related"
		}
		t.Run(name, func(t *testing.T) {
			s, srv, _, _, _ := newRetargetFixture(t)
			deploymentID := "other-deployment"
			if related {
				deploymentID = "deployment"
			}
			record := map[string]any{"id": "future-route", "deploymentId": deploymentID, "futureSecretPolicy": "not-for-review"}
			if err := s.Put("published-routes", "future-route", record); err != nil {
				t.Fatal(err)
			}
			code, _, raw := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", retargetInput(t, srv))
			expected := 200
			if related {
				expected = 422
			}
			if code != expected || strings.Contains(raw, "not-for-review") {
				t.Fatalf("%s shape scope %d %s", name, code, raw)
			}
		})
	}
}

func TestManagedRouteRetargetOperationalProofFailureDoesNotFinalizeOperation(t *testing.T) {
	for _, kind := range []string{"agent-observations", "published-manifests"} {
		t.Run(kind, func(t *testing.T) {
			s, srv, deployment, _, _ := newRetargetFixture(t)
			recordOldRetargetObservations(t, s, srv, deployment)
			input := retargetInput(t, srv)
			code, preview, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", input)
			if code != 200 {
				t.Fatalf("preview %d %s", code, body)
			}
			input["reviewToken"] = preview["reviewToken"]
			input["operationId"] = "operational-read-failure"
			id := "fra-core"
			if kind == "published-manifests" {
				id = "rev_fra-core"
			}
			var original json.RawMessage
			if err := s.Get(kind, id, &original); err != nil {
				t.Fatal(err)
			}
			var malformed map[string]any
			json.Unmarshal(original, &malformed)
			if kind == "agent-observations" {
				malformed["highestAccepted"] = "private-invalid-number"
			} else {
				malformed["program"] = "private-invalid-program"
			}
			if err := s.Put(kind, id, malformed); err != nil {
				t.Fatal(err)
			}
			code, _, body = req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
			if code == 200 || strings.Contains(body, "draft-rejected") || strings.Contains(body, "private-invalid") {
				t.Fatalf("unclassified operational read became terminal/private: %d %s", code, body)
			}
			receipts, err := s.List("route-exit-receipts")
			if err != nil || len(receipts) != 0 {
				t.Fatalf("operational failure claimed receipt: %d %v", len(receipts), err)
			}
			if err = s.Put(kind, id, original); err != nil {
				t.Fatal(err)
			}
			code, outcome, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget", "", input)
			if code != 200 || outcome["status"] != "draft-saved" {
				t.Fatalf("same-operation recovery blocked: %d %s", code, body)
			}
		})
	}
}

func TestManagedRouteRetargetRefusesUnknownExistingLinkFields(t *testing.T) {
	s, srv, _, _, _ := newRetargetFixture(t)
	sum := sha256.Sum256([]byte("fra\x00new-uk"))
	id := "path_" + hex.EncodeToString(sum[:16])
	original := map[string]any{"id": id, "from": "fra", "to": "new-uk", "futureSecretPolicy": "private-link-semantics"}
	if err := s.Put("links", id, original); err != nil {
		t.Fatal(err)
	}
	code, _, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", retargetInput(t, srv))
	if code != 422 || strings.Contains(body, "private-link-semantics") {
		t.Fatalf("unsupported link accepted or exposed: %d %s", code, body)
	}
	var after map[string]any
	if err := s.Get("links", id, &after); err != nil || !reflect.DeepEqual(after, original) {
		t.Fatalf("existing link changed: %v %v", after, err)
	}
}

func TestManagedRouteRetargetRefusesPresentMalformedLinkInsteadOfRepairingIt(t *testing.T) {
	for _, kind := range []string{"null", "empty-id"} {
		t.Run(kind, func(t *testing.T) {
			s, srv, _, _, _ := newRetargetFixture(t)
			sum := sha256.Sum256([]byte("fra\x00new-uk"))
			id := "path_" + hex.EncodeToString(sum[:16])
			var value any
			if kind == "empty-id" {
				value = map[string]any{"id": "", "from": "fra", "to": "new-uk"}
			}
			if err := s.Put("links", id, value); err != nil {
				t.Fatal(err)
			}
			var before json.RawMessage
			if err := s.Get("links", id, &before); err != nil {
				t.Fatal(err)
			}
			code, _, body := req(t, operatorClient(), "POST", srv.URL+"/api/published-routes/route/retarget/preview", "", retargetInput(t, srv))
			if code != 409 {
				t.Fatalf("present malformed link silently repaired: %d %s", code, body)
			}
			var after json.RawMessage
			if err := s.Get("links", id, &after); err != nil || !bytes.Equal(before, after) {
				t.Fatalf("malformed link overwritten %s %v", after, err)
			}
		})
	}
}
