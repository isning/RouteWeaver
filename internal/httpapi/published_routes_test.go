package httpapi_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
)

// Public seams: administrator provisioning, tenant output, scoped agent
// observations. The observation fixture exercises control-plane evidence gates;
// real native multi-user traffic has its own integration proof.
func TestPublishedRoutePrincipalsRequireExactAppliedManifest(t *testing.T) {
	testPublishedRoutePrincipals(t, false)
}
func testPublishedRoutePrincipals(t *testing.T, native bool) {
	s, srv := makeServer(t)
	admin := operatorClient()
	alice := inviteClient(t, s, srv, "managed-alice")
	bob := inviteClient(t, s, srv, "managed-bob")
	post := func(path string, body any) map[string]any {
		t.Helper()
		code, out, raw := req(t, admin, "POST", srv.URL+"/api/"+path, "", body)
		if code != 200 && code != 201 {
			t.Fatalf("POST %s: %d %s", path, code, raw)
		}
		return out
	}
	entryPort, transitPort := 12345, 12346
	if native {
		entryPort, transitPort = publishedFreePort(t), publishedFreePort(t)
	}
	host := domain.Host{ID: "managed-host", Name: "Synthetic host", Address: "127.0.0.1"}
	instance := domain.CoreInstance{ID: "managed-core", HostID: host.ID, AdapterID: render.ServerAdapterManagedXray, Version: render.ManagedXrayVersion}
	endpoint := domain.ManagedEndpoint{ID: "managed-entry", InstanceID: instance.ID, Name: "Synthetic entry", Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: entryPort, UUID: "00000000-0000-4000-8000-000000000099"}}
	post("hosts", host)
	post("core-instances", instance)
	post("managed-endpoints", endpoint)
	transitInstance := domain.CoreInstance{ID: "transit-core", HostID: host.ID, AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}
	transitEndpoint := domain.ManagedEndpoint{ID: "transit-entry", InstanceID: transitInstance.ID, Name: "Private transit", Connection: domain.Connection{Protocol: "socks", Host: "127.0.0.1", Port: transitPort, Username: "transit-only", Password: "must-never-reach-public-credential"}}
	transitDial := transitEndpoint.Connection
	if !native {
		transitEndpoint.Connection.Host = "0.0.0.0"
	}
	post("core-instances", transitInstance)
	post("managed-endpoints", transitEndpoint)
	deployment := httpapi.ServerDeployment{ID: "managed-deployment", Name: "Managed deployment", IR: domain.ServerDeploymentIR{SchemaVersion: "1.0", TopologyRevision: "topology1", Programs: []domain.ServerProgram{{Instance: instance, Listener: endpoint, DestinationPolicy: &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}, Egress: []domain.Connection{transitDial}}, {Instance: transitInstance, Listener: transitEndpoint}}}}
	post("server-deployments", deployment)
	route := map[string]any{"id": "published-route", "name": "Public transit route", "deploymentId": deployment.ID, "endpointIds": []string{endpoint.ID, transitEndpoint.ID}, "publicHost": "127.0.0.1", "publicPort": entryPort}
	if !native {
		wrongHost := host
		wrongHost.Address = "192.0.2.5"
		post("hosts", wrongHost)
		if code, _, raw := req(t, admin, "POST", srv.URL+"/api/published-routes/preview", "", route); code != 422 {
			t.Fatalf("wildcard next hop accepted an unregistered dial address %d %s", code, raw)
		}
		post("hosts", host)
	}
	publicInsecure := map[string]any{}
	for k, v := range route {
		publicInsecure[k] = v
	}
	publicInsecure["publicHost"] = "public.example"
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/published-routes/preview", "", publicInsecure); code != 422 {
		t.Fatalf("public raw UUID entry accepted without TLS %d %s", code, raw)
	}
	preview := post("published-routes/preview", route)
	if preview["status"] != "draft" {
		t.Fatalf("preview claims application: %v", preview)
	}
	post("published-routes", route)
	post("published-routes/preview", map[string]any{"id": "direct-preview", "name": "Direct path", "deploymentId": deployment.ID, "endpointIds": []string{endpoint.ID}, "publicHost": "127.0.0.1", "publicPort": entryPort})
	plan := service.Plan{ID: "managed-plan", Name: "Managed service", QuotaBytes: 1 << 20, RouteIDs: []string{"published-route"}, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	post("services", plan)
	for _, owner := range []string{alice.id, bob.id} {
		serviceID := plan.ID
		if owner == alice.id {
			serviceID = ""
		} // Alice inherits, Bob has an explicit individual service.
		code, _, raw := req(t, admin, "PUT", srv.URL+"/api/users/"+owner+"/entitlement", "", service.Entitlement{ServiceID: serviceID, Cycle: plan.Cycle})
		if code != 200 {
			t.Fatalf("entitle %d %s", code, raw)
		}
	}
	groupChange := service.PolicyChange{Group: &service.Group{ID: "managed-members", Name: "Managed members", ServiceID: plan.ID, Priority: 10, MemberIDs: []string{alice.id}}}
	groupPreview := post("access-policy/preview", groupChange)
	post("access-policy/apply", map[string]any{"change": groupChange, "revision": groupPreview["revision"]})
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/users/"+alice.id+"/entries", "", httpapi.PublicEntryGrant{ID: "legacy-bypass", RouteID: "published-route", Name: "Not managed", CredentialVersion: "v1", Connection: endpoint.Connection}); code != 409 {
		t.Fatalf("legacy configured credential masqueraded as published route %d %s", code, raw)
	}
	grantA := post("published-routes/published-route/principals", map[string]any{"accountId": alice.id, "entryId": "alice-entry", "credentialVersion": "v1"})
	grantB := post("published-routes/published-route/principals", map[string]any{"accountId": bob.id, "entryId": "bob-entry", "credentialVersion": "v1"})
	if grantA["subjectId"] == grantB["subjectId"] || grantA["status"] != "pending-deployment" {
		t.Fatal("principals not opaque or draft")
	}
	if code, _, raw := req(t, alice.c, "POST", srv.URL+"/api/published-routes/published-route/principals", alice.csrf, map[string]string{"accountId": alice.id, "credentialVersion": "evil"}); code != 403 {
		t.Fatalf("tenant altered managed principal %d %s", code, raw)
	}
	reveal := srv.URL + "/api/users/" + alice.id + "/entries/alice-entry/reveal"
	if code, _, raw := req(t, admin, "GET", reveal, "", nil); code != 409 {
		t.Fatalf("unapplied credential revealed %d %s", code, raw)
	}
	enrollment := post("agent/enrollments", map[string]any{"nodeId": host.ID, "instanceId": instance.ID, "expiresAt": time.Now().Add(time.Hour)})
	var scope agent.Scope
	raw, _ := json.Marshal(enrollment["scope"])
	json.Unmarshal(raw, &scope)
	transport, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Token: enrollment["token"].(string), Scope: scope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	defer transport.Close()
	transitEnrollment := post("agent/enrollments", map[string]any{"nodeId": host.ID, "instanceId": transitInstance.ID, "expiresAt": time.Now().Add(time.Hour)})
	var transitScope agent.Scope
	transitRaw, _ := json.Marshal(transitEnrollment["scope"])
	json.Unmarshal(transitRaw, &transitScope)
	transitTransport, e := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Token: transitEnrollment["token"].(string), Scope: transitScope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if e != nil {
		t.Fatal(e)
	}
	defer transitTransport.Close()
	opened := openServerDraft(t, admin, srv.URL+"/api/server-deployments/managed-deployment")
	validation := requireServerValidation(t, admin, srv.URL+"/api/server-deployments/managed-deployment", opened["revisionToken"].(string))
	if validation["valid"] != true {
		t.Fatalf("invalid managed draft: %v", validation)
	}
	publication := post("server-deployments/managed-deployment/publish", map[string]any{"operationId": "publish-managed", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": validation["fingerprint"]})
	if publication["status"] != "publication-accepted" || publication["nativeChecked"] != false {
		t.Fatalf("publication not accepted: %v", publication)
	}
	desired, e := transport.ReceiveDesired(context.Background(), scope, 0)
	if e != nil || desired == nil {
		t.Fatalf("desired %v %v", desired, e)
	}
	if code, _, raw := req(t, admin, "GET", reveal, "", nil); code != 409 {
		t.Fatalf("queued credential revealed %d %s", code, raw)
	}
	transitDesired, e := transitTransport.ReceiveDesired(context.Background(), transitScope, 0)
	if e != nil || transitDesired == nil {
		t.Fatalf("transit desired %v %v", transitDesired, e)
	}
	var nativeTransitState agent.State
	if native {
		nativeTransitState = runPublishedNativeTarget(t, *transitDesired, transitTransport)
	}
	identity := desired.Identity()
	state := agent.State{Desired: &identity, NativeChecked: true, Phase: agent.ObservedConformant, Observed: &agent.Observation{Identity: identity, Known: true, Quiescent: true, ObservedAt: time.Now()}}
	if native {
		state = runPublishedNativeTarget(t, *desired, transport)
	}
	if e = transport.ReportObservation(context.Background(), scope, state); e != nil {
		t.Fatal(e)
	}
	if code, _, raw := req(t, admin, "GET", reveal, "", nil); code != 409 {
		t.Fatalf("partially applied path exposed public credential %d %s", code, raw)
	}

	transitIdentity := transitDesired.Identity()
	transitState := agent.State{Desired: &transitIdentity, NativeChecked: true, Phase: agent.ObservedConformant, Observed: &agent.Observation{Identity: transitIdentity, Known: true, Quiescent: true, ObservedAt: time.Now()}}
	if native {
		transitState = nativeTransitState
	}
	if e = transitTransport.ReportObservation(context.Background(), transitScope, transitState); e != nil {
		t.Fatal(e)
	}
	assertPublishedDiagnosticSelection(t, srv.URL, admin, alice.c, transport, scope, transitEndpoint.Connection.Password)
	var firstUUID string
	if code, out, raw := req(t, admin, "GET", reveal, "", nil); code != 200 || out["subjectId"] != grantA["subjectId"] || strings.Contains(raw, "00000000-0000-4000-8000-000000000099") || strings.Contains(raw, transitEndpoint.Connection.Password) {
		t.Fatalf("applied own entry %d %s", code, raw)
	} else {
		firstUUID = out["connection"].(map[string]any)["uuid"].(string)
	}
	if !native {
		// A reopened journal can retain its last conformant observation while
		// requiring recovery. The standard driver recovers before reporting, but
		// this representable state is accepted by the scoped observation API.
		for _, hop := range []struct {
			name   string
			report func(bool) error
		}{
			{"entry", func(recovery bool) error {
				report := state
				report.RecoveryRequired = recovery
				return transport.ReportObservation(context.Background(), scope, report)
			}},
			{"transit", func(recovery bool) error {
				report := transitState
				report.RecoveryRequired = recovery
				return transitTransport.ReportObservation(context.Background(), transitScope, report)
			}},
		} {
			t.Run("recovery-required-"+hop.name+"-withholds-published-delivery", func(t *testing.T) {
				if err := hop.report(true); err != nil {
					t.Fatalf("scoped recovery observation rejected: %v", err)
				}
				if code, out, raw := req(t, admin, "GET", srv.URL+"/api/published-routes/published-route/resolve", "", nil); code != 200 || out["status"] == "effective" || out["effective"] != nil {
					t.Errorf("recovery-required hop retained effective public path: %d %s", code, raw)
				}
				if code, _, raw := req(t, admin, "GET", reveal, "", nil); code != 409 {
					t.Errorf("recovery-required hop allowed platform entry delivery: %d %s", code, raw)
				}
				if err := hop.report(false); err != nil {
					t.Fatalf("confirmed recovery observation rejected: %v", err)
				}
				if code, out, raw := req(t, admin, "GET", srv.URL+"/api/published-routes/published-route/resolve", "", nil); code != 200 || out["status"] != "effective" || out["effective"] == nil {
					t.Errorf("confirmed recovery did not restore public path: %d %s", code, raw)
				}
				if code, _, raw := req(t, admin, "GET", reveal, "", nil); code != 200 {
					t.Errorf("confirmed recovery did not restore platform entry delivery: %d %s", code, raw)
				}
			})
		}
	}
	if native {
		provePublishedPrincipalTraffic(t, entryPort, firstUUID, nil)
		expected := float64(len("published-admitted-payload") * 2)
		deadline := time.Now().Add(3 * time.Second)
		for {
			code, out, raw := req(t, alice.c, "GET", srv.URL+"/api/me/overview", "", nil)
			if code != 200 {
				t.Fatalf("settled overview %d %s", code, raw)
			}
			usage := out["usage"].(map[string]any)
			if usage["rawBytes"] == expected && usage["weightedBytes"] == expected && out["accountingPending"] == false {
				break
			}
			if !time.Now().Before(deadline) {
				t.Fatalf("native payload did not settle exactly once into canonical quota ledger: %s", raw)
			}
			time.Sleep(20 * time.Millisecond)
		}
		provePublishedSharedBudget(t, post, srv.URL, admin, alice, plan, host.ID, entryPort, firstUUID)
		provePublishedConnectionLimits(t, post, srv.URL, admin, alice, plan, entryPort, firstUUID)
	}
	if code, _, raw := req(t, bob.c, "GET", reveal, "", nil); code != 403 {
		t.Fatalf("cross account reveal %d %s", code, raw)
	}
	// A mutable public-route draft never changes the last immutable credential.
	route["name"] = "Renamed draft"
	route["publicPort"] = 23456
	_, routeBaseline, _ := req(t, admin, "GET", srv.URL+"/api/published-routes/published-route/resolve", "", nil)
	if code, _, raw := putAdminRecord(t, admin, srv.URL+"/api/published-routes/published-route", routeBaseline["revisionToken"].(string), route); code != 200 {
		t.Fatalf("edit %d %s", code, raw)
	}
	if code, out, raw := req(t, admin, "GET", reveal, "", nil); code != 200 || out["connection"].(map[string]any)["port"] != float64(entryPort) {
		t.Fatalf("draft replaced effective credential %d %s", code, raw)
	}
	if code, out, raw := req(t, admin, "GET", srv.URL+"/api/published-routes/published-route/resolve", "", nil); code != 200 || out["pendingChanges"] != true || out["effective"].(map[string]any)["publicPort"] != float64(entryPort) || out["publicPort"] != float64(23456) {
		t.Fatalf("draft readiness hid the frozen effective address %d %s", code, raw)
	}
	// Native evidence must include the exact pinned operation, not just revision.
	state.Observed.Identity.OperationID = "unrelated-operation"
	if e = transport.ReportObservation(context.Background(), scope, state); e == nil {
		t.Fatal("mismatched applied identity accepted")
	}
	// A retired version cannot be revived through either provisioning endpoint.
	post("published-routes/published-route/principals", map[string]any{"accountId": alice.id, "entryId": "alice-entry", "credentialVersion": "v2"})
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/published-routes/published-route/principals", "", map[string]any{"accountId": alice.id, "entryId": "alice-entry", "credentialVersion": "v1"}); code != 409 {
		t.Fatalf("retired managed version revived %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "GET", reveal, "", nil); code != 409 {
		t.Fatalf("new draft version inherited old apply %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/published-routes/published-route/principals", "", map[string]any{"accountId": alice.id, "entryId": "replacement-entry", "credentialVersion": "v3", "credential": domain.PrincipalCredential{UUID: firstUUID}}); code != 409 {
		t.Fatalf("old native credential revived under a fresh grant/version %d %s", code, raw)
	}
	post("agent/enrollments", map[string]any{"nodeId": host.ID, "instanceId": transitInstance.ID, "expiresAt": time.Now().Add(time.Hour)})
	if code, _, raw := req(t, admin, "GET", srv.URL+"/api/users/"+bob.id+"/entries/bob-entry/reveal", "", nil); code != 409 {
		t.Fatalf("replaced transit enrollment inherited stale apply evidence %d %s", code, raw)
	}
}
