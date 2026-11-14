package httpapi_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
)

// This public HTTP fixture reports synthetic scoped observations. It neither
// executes a native core nor establishes real forwarding/client application.
type rotationRecoveryFixture struct {
	t       *testing.T
	s       *store.Store
	srv     *httptest.Server
	admin   *http.Client
	owner   sessionClient
	other   sessionClient
	agents  []*agent.HTTPTransport
	scopes  []agent.Scope
	desired []*agent.Desired
}

func newRotationRecoveryFixture(t *testing.T, additionalEntries ...string) *rotationRecoveryFixture {
	return newRotationRecoveryFixtureAtPorts(t, 12345, 12346, additionalEntries...)
}

func newRotationRecoveryFixtureAtPorts(t *testing.T, entryPort, transitPort int, additionalEntries ...string) *rotationRecoveryFixture {
	t.Helper()
	s, srv := makeServer(t)
	f := &rotationRecoveryFixture{t: t, s: s, srv: srv, admin: operatorClient(), owner: inviteClient(t, s, srv, "rotation-owner"), other: inviteClient(t, s, srv, "rotation-other")}
	host := domain.Host{ID: "rotation-host", Name: "Synthetic rotation host", Address: "127.0.0.1"}
	entryCore := domain.CoreInstance{ID: "rotation-core", HostID: host.ID, AdapterID: render.ServerAdapterManagedXray, Version: render.ManagedXrayVersion}
	transitCore := domain.CoreInstance{ID: "rotation-transit", HostID: host.ID, AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}
	entry := domain.ManagedEndpoint{ID: "rotation-entry", InstanceID: entryCore.ID, Name: "Synthetic public entry", Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: entryPort, UUID: "11111111-1111-4111-8111-111111111111"}}
	transit := domain.ManagedEndpoint{ID: "rotation-exit", InstanceID: transitCore.ID, Name: "Synthetic transit", Connection: domain.Connection{Protocol: "socks", Host: "127.0.0.1", Port: transitPort, Username: "rotation-transit-user", Password: "rotation-transit-secret"}}
	f.postAdmin("hosts", host)
	for _, core := range []domain.CoreInstance{entryCore, transitCore} {
		f.postAdmin("core-instances", core)
	}
	for _, endpoint := range []domain.ManagedEndpoint{entry, transit} {
		f.postAdmin("managed-endpoints", endpoint)
	}
	deployment := httpapi.ServerDeployment{ID: "rotation-path", Name: "Synthetic rotation path", IR: domain.ServerDeploymentIR{SchemaVersion: "1.0", TopologyRevision: "rotation-topology", Programs: []domain.ServerProgram{{Instance: entryCore, Listener: entry, Egress: []domain.Connection{transit.Connection}, DestinationPolicy: &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}}, {Instance: transitCore, Listener: transit}}}}
	f.postAdmin("server-deployments", deployment)
	f.postAdmin("published-routes", map[string]any{"id": "rotation-line", "name": "Synthetic rotation line", "deploymentId": deployment.ID, "endpointIds": []string{entry.ID, transit.ID}, "publicHost": "127.0.0.1", "publicPort": entryPort})
	plan := service.Plan{ID: "rotation-service", Name: "Synthetic service", QuotaBytes: 1 << 20, RouteIDs: []string{"rotation-line"}, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	f.postAdmin("services", plan)
	code, _, _ := req(t, f.admin, "PUT", srv.URL+"/api/users/"+f.owner.id+"/entitlement", "", service.Entitlement{ServiceID: plan.ID, Cycle: plan.Cycle})
	if code != 200 {
		t.Fatalf("synthetic entitlement status=%d", code)
	}
	f.rotate("credential-v1")
	for _, id := range additionalEntries {
		f.rotateEntry(id, "credential-v1")
	}
	for _, core := range []domain.CoreInstance{entryCore, transitCore} {
		enrollment := f.postAdmin("agent/enrollments", map[string]any{"nodeId": host.ID, "instanceId": core.ID, "expiresAt": time.Now().Add(time.Hour)})
		var scope agent.Scope
		raw, _ := json.Marshal(enrollment["scope"])
		if err := json.Unmarshal(raw, &scope); err != nil {
			t.Fatal(err)
		}
		transport, err := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Token: enrollment["token"].(string), Scope: scope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(transport.Close)
		f.agents = append(f.agents, transport)
		f.scopes = append(f.scopes, scope)
	}
	f.queue("rotation-initial")
	f.observe(0, false)
	f.observe(1, false)
	profile := httpapi.Profile{ID: "rotation-profile", Name: "Shared synthetic profile", Target: render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, Mode: render.FullConfig, PlatformEntryIDs: []string{"rotation-grant"}, IR: domain.ClientProfileIR{SchemaVersion: "1.0", DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: "rotation-grant"}}}
	f.ownerRequest("POST", "/me/profiles", profile, 200)
	return f
}

func (f *rotationRecoveryFixture) postAdmin(path string, body any) map[string]any {
	f.t.Helper()
	code, out, _ := req(f.t, f.admin, "POST", f.srv.URL+"/api/"+path, "", body)
	if code != 200 && code != 201 {
		f.t.Fatalf("synthetic admin %s status=%d", path, code)
	}
	return out
}

func (f *rotationRecoveryFixture) ownerRequest(method, path string, body any, want int) map[string]any {
	f.t.Helper()
	code, out, _ := req(f.t, f.owner.c, method, f.srv.URL+"/api"+path, f.owner.csrf, body)
	if code != want {
		f.t.Fatalf("owner %s %s status=%d want=%d", method, path, code, want)
	}
	return out
}

func (f *rotationRecoveryFixture) rotate(version string) {
	f.t.Helper()
	f.rotateEntry("rotation-grant", version)
}

func (f *rotationRecoveryFixture) rotateEntry(id, version string) {
	f.t.Helper()
	f.postAdmin("published-routes/rotation-line/principals", map[string]any{"accountId": f.owner.id, "entryId": id, "credentialVersion": version})
}

func (f *rotationRecoveryFixture) queue(operation string) {
	f.t.Helper()
	url := f.srv.URL + "/api/server-deployments/rotation-path"
	opened := openServerDraft(f.t, f.admin, url)
	checked := requireServerValidation(f.t, f.admin, url, opened["revisionToken"].(string))
	accepted := f.postAdmin("server-deployments/rotation-path/publish", map[string]any{"operationId": operation, "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": checked["fingerprint"]})
	if accepted["status"] != "publication-accepted" {
		f.t.Fatalf("synthetic operation not accepted: status=%v code=%v", accepted["status"], accepted["code"])
	}
	f.desired = nil
	for i, transport := range f.agents {
		desired, err := transport.ReceiveDesired(context.Background(), f.scopes[i], 0)
		if err != nil || desired == nil {
			f.t.Fatalf("synthetic desired unavailable: %v", err)
		}
		f.desired = append(f.desired, desired)
	}
}

func (f *rotationRecoveryFixture) observe(index int, recovery bool) {
	f.t.Helper()
	identity := f.desired[index].Identity()
	state := agent.State{Desired: &identity, NativeChecked: true, RecoveryRequired: recovery, Phase: agent.ObservedConformant, Observed: &agent.Observation{Identity: identity, Known: true, Quiescent: true, ObservedAt: time.Now()}}
	if err := f.agents[index].ReportObservation(context.Background(), f.scopes[index], state); err != nil {
		f.t.Fatal(err)
	}
}

func (f *rotationRecoveryFixture) accessBlocked(id, expected string) {
	f.t.Helper()
	code, out, raw := req(f.t, f.owner.c, "GET", f.srv.URL+"/api/me/outputs/"+id+"/access", "", nil)
	if code != 409 || out["code"] != expected {
		// Do not dump a baseline response containing its real fixture feed token.
		f.t.Errorf("access must expose safe %s, got status=%d code=%v", expected, code, out["code"])
	}
	for key := range out {
		if key != "code" && key != "detail" {
			f.t.Errorf("blocked access exposes unexpected field %q", key)
		}
	}
	for _, sensitive := range []string{"rotation-transit-secret", "rotation-transit-user", "credential-v1", "credential-v2", "127.0.0.1", "/feed/", "subjectId", "connectionDigest"} {
		if strings.Contains(raw, sensitive) {
			f.t.Errorf("blocked access contains prohibited fixture marker %q", sensitive)
		}
	}
}

func TestOutputRotationRecoveryDistinguishesConfirmationFromRepublishing(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	first := f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "rotation-phone", "name": "Phone", "profileId": "rotation-profile"}, 201)
	sibling := f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "rotation-laptop", "name": "Laptop", "profileId": "rotation-profile"}, 201)
	access := f.ownerRequest("GET", "/me/outputs/rotation-phone/access", nil, 200)
	feed := f.srv.URL + first["feedPath"].(string)
	code, _, initialBody := req(t, http.DefaultClient, "GET", feed, "", nil)
	if code != 200 {
		t.Fatalf("initial frozen feed status=%d", code)
	}
	code, _, foreign := req(t, f.other.c, "GET", f.srv.URL+"/api/me/outputs/rotation-phone/access", "", nil)
	if code != 404 || strings.Contains(foreign, "OUTPUT_") || strings.Contains(foreign, "/feed/") {
		t.Fatal("cross-owner access disclosed readiness or a link")
	}
	f.rotate("credential-v2")
	if code, _, _ = req(t, http.DefaultClient, "GET", feed, "", nil); code != 403 {
		t.Fatalf("old frozen feed after rotation status=%d", code)
	}
	f.accessBlocked("rotation-phone", "OUTPUT_ENTRY_UNCONFIRMED")
	f.queue("rotation-replacement")
	f.observe(0, false)
	f.accessBlocked("rotation-phone", "OUTPUT_ENTRY_UNCONFIRMED")
	f.observe(1, false)
	f.accessBlocked("rotation-phone", "OUTPUT_REPUBLISH_REQUIRED")
	f.accessBlocked("rotation-laptop", "OUTPUT_REPUBLISH_REQUIRED")
	beforeUpdate := f.ownerRequest("GET", "/me/outputs/rotation-phone/status", nil, 200)
	if beforeUpdate["revision"] != first["revision"] {
		t.Fatal("readiness observation changed the frozen publication")
	}
	if code, _, _ = req(t, http.DefaultClient, "GET", feed, "", nil); code != 403 {
		t.Fatalf("new applied entry silently refreshed frozen feed status=%d", code)
	}
	checked := f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{"outputId": "rotation-phone"}, 200)
	updated := f.ownerRequest("POST", "/me/outputs/rotation-phone/publish", map[string]any{"previewDigest": checked["previewDigest"]}, 200)
	if updated["id"] != first["id"] || updated["revision"] == first["revision"] || !reflect.DeepEqual(updated["target"], first["target"]) || updated["mode"] != first["mode"] {
		t.Fatal("explicit update did not retain output identity/target/mode and change publication")
	}
	after := f.ownerRequest("GET", "/me/outputs/rotation-phone/access", nil, 200)
	if !reflect.DeepEqual(access, after) {
		t.Fatal("explicit update rotated or changed the original access link")
	}
	code, _, updatedBody := req(t, http.DefaultClient, "GET", feed, "", nil)
	if code != 200 || updatedBody == initialBody {
		t.Fatal("explicit update did not make the current credential deliverable")
	}
	f.accessBlocked("rotation-laptop", "OUTPUT_REPUBLISH_REQUIRED")
	siblingAfter := f.ownerRequest("GET", "/me/outputs/rotation-laptop/status", nil, 200)
	if siblingAfter["revision"] != sibling["revision"] {
		t.Fatal("repairing one output changed its sibling")
	}
	f.observe(1, true)
	f.accessBlocked("rotation-phone", "OUTPUT_ENTRY_UNCONFIRMED")
}

func TestOutputRotationRecoveryDoesNotMisclassifyRevocationOrPlatformSuspension(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "rotation-phone", "name": "Phone", "profileId": "rotation-profile"}, 201)
	ruleBody := "payload:\n  - '+.rotation-private.example'\n"
	resource := f.ownerRequest("POST", "/me/resources/import", map[string]any{"resource": map[string]any{"id": "rotation-private-rules", "name": "Private rules", "format": "mihomo-yaml", "behavior": "domain", "updatePolicy": "pinned"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte(ruleBody))}, 201)
	private := httpapi.Profile{ID: "private-profile", Name: "Own configuration", Target: render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, Mode: render.FullConfig, IR: domain.ClientProfileIR{SchemaVersion: "1.0", DefaultAction: domain.ActionRef{Kind: "direct"}}}
	private.IR.Resources = []domain.RuleResource{{ID: "rotation-private-rules"}}
	private.IR.Rules = []domain.PolicyRule{{ID: "private-rule", Match: domain.MatchExpression{Op: "resource", Value: "rotation-private-rules"}, Action: domain.ActionRef{Kind: "reject"}}}
	f.ownerRequest("POST", "/me/profiles", private, 200)
	privateOutput := f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "private-output", "name": "Private", "profileId": private.ID}, 201)
	privateAccess := f.ownerRequest("GET", "/me/outputs/private-output/access", nil, 200)
	privateFiles := downloadBundle(t, f.owner.c, f.srv.URL+privateOutput["downloadPath"].(string))
	if string(privateFiles[resource["path"].(string)]) != ruleBody {
		t.Fatal("private bundle does not preserve the explicitly accepted resource")
	}
	code, _, _ := req(t, f.admin, "DELETE", f.srv.URL+"/api/users/"+f.owner.id+"/entries/rotation-grant", "", nil)
	if code != 200 {
		t.Fatalf("synthetic grant revocation status=%d", code)
	}
	f.accessUnavailable("rotation-phone", "revoked grant", 409)
	f.rotate("credential-v2")
	code, _, _ = req(t, f.admin, "PUT", f.srv.URL+"/api/users/"+f.owner.id+"/entitlement", "", service.Entitlement{ServiceID: "rotation-service", Paused: true, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}})
	if code != 200 {
		t.Fatalf("synthetic platform pause status=%d", code)
	}
	f.accessUnavailable("rotation-phone", "paused service with a newer unconfirmed grant", 409)
	if after := f.ownerRequest("GET", "/me/outputs/private-output/access", nil, 200); !reflect.DeepEqual(privateAccess, after) {
		t.Fatal("platform suspension changed independent private-source access")
	}
	if after := downloadBundle(t, f.owner.c, f.srv.URL+privateOutput["downloadPath"].(string)); !reflect.DeepEqual(privateFiles, after) {
		t.Fatal("platform suspension changed independent private bundle")
	}
}

func (f *rotationRecoveryFixture) accessUnavailable(id, phase string, wantStatus int) {
	f.t.Helper()
	code, out, raw := req(f.t, f.owner.c, "GET", f.srv.URL+"/api/me/outputs/"+id+"/access", "", nil)
	wantDetail := "This subscription is currently unavailable. Please check your access."
	if wantStatus == 503 {
		wantDetail = "Subscription availability could not be checked. Please try again."
	}
	if code != wantStatus || out["detail"] != wantDetail || len(out) != 1 {
		f.t.Errorf("%s must retain exact safe generic response: status=%d want=%d code=%v", phase, code, wantStatus, out["code"])
	}
	for _, key := range []string{"feedPath", "feedURL", "bundlePath", "bundleURL", "downloadPath", "token", "credentialVersion", "subjectId"} {
		if out[key] != nil {
			f.t.Errorf("%s exposes %s", phase, key)
		}
	}
	for _, prohibited := range []string{"synthetic-corrupt-record", "cannot unmarshal", "published-manifests", "instance-enrollments", "rotation-transit-secret", "/feed/"} {
		if strings.Contains(raw, prohibited) {
			f.t.Errorf("%s exposes a prohibited storage/secret marker", phase)
		}
	}
}

func TestOutputRotationRecoveryAggregatesMixedDependenciesInEitherOrder(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		name := "republish-before-unconfirmed"
		if reverse {
			name = "unconfirmed-before-republish"
		}
		t.Run(name, func(t *testing.T) {
			f := newRotationRecoveryFixture(t, "rotation-second")
			p := httpapi.Profile{ID: "mixed-profile", Name: "Two managed entries", Target: render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, Mode: render.FullConfig, PlatformEntryIDs: []string{"rotation-grant", "rotation-second"}, IR: domain.ClientProfileIR{SchemaVersion: "1.0", DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: "rotation-grant"}}}
			f.ownerRequest("POST", "/me/profiles", p, 200)
			f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "mixed-output", "name": "Mixed", "profileId": p.ID}, 201)
			// Fixture-only ordering injection; assertions remain public /access
			// behavior. No test depends on the materializer's iteration order.
			var frozen httpapi.Output
			if err := f.s.TenantGet(f.owner.id, "outputs", "mixed-output", &frozen); err != nil {
				t.Fatal(err)
			}
			byID := map[string]httpapi.EntryDependency{}
			for _, dependency := range frozen.PlatformDependencies {
				byID[dependency.ID] = dependency
			}
			if len(byID) != 2 || byID["rotation-grant"].ID == "" || byID["rotation-second"].ID == "" {
				t.Fatal("fixture did not freeze both selected platform entries")
			}
			frozen.PlatformDependencies = []httpapi.EntryDependency{byID["rotation-grant"], byID["rotation-second"]}
			if reverse {
				frozen.PlatformDependencies[0], frozen.PlatformDependencies[1] = frozen.PlatformDependencies[1], frozen.PlatformDependencies[0]
			}
			if err := f.s.TenantPut(f.owner.id, "outputs", frozen.ID, frozen); err != nil {
				t.Fatal(err)
			}
			f.rotate("credential-v2")
			f.queue("mixed-first-confirmed")
			f.observe(0, false)
			f.observe(1, false)
			f.accessBlocked(frozen.ID, "OUTPUT_REPUBLISH_REQUIRED")
			// The first grant is confirmed-but-newer; the second grant now lacks
			// its exact principal in the still-valid confirmed manifest.
			f.rotateEntry("rotation-second", "credential-v2")
			f.accessBlocked(frozen.ID, "OUTPUT_ENTRY_UNCONFIRMED")
			// An identity mismatch is not credential rotation. It must win over
			// another dependency's expected missing confirmation in either order.
			for i := range frozen.PlatformDependencies {
				if frozen.PlatformDependencies[i].ID == "rotation-grant" {
					frozen.PlatformDependencies[i].RouteID = "different-frozen-route"
				}
			}
			if err := f.s.TenantPut(f.owner.id, "outputs", frozen.ID, frozen); err != nil {
				t.Fatal(err)
			}
			f.accessUnavailable(frozen.ID, "frozen route identity mismatch before pending entry", 409)
			for i := range frozen.PlatformDependencies {
				frozen.PlatformDependencies[i].RouteID = "rotation-line"
			}
			if err := f.s.TenantPut(f.owner.id, "outputs", frozen.ID, frozen); err != nil {
				t.Fatal(err)
			}
			code, _, _ := req(t, f.admin, "DELETE", f.srv.URL+"/api/users/"+f.owner.id+"/entries/rotation-grant", "", nil)
			if code != 200 {
				t.Fatalf("mixed grant revocation status=%d", code)
			}
			f.accessUnavailable(frozen.ID, "revoked grant before pending entry", 409)
		})
	}
}

func TestOutputRotationRecoveryDoesNotTurnCorruptionIntoExpectedConfirmationWait(t *testing.T) {
	cases := []struct {
		name   string
		inject func(*rotationRecoveryFixture) error
	}{
		{"referenced-manifest-decode", func(f *rotationRecoveryFixture) error {
			return f.s.Put("published-manifests", f.desired[0].RevisionID, "synthetic-corrupt-record")
		}},
		{"referenced-enrollment-decode", func(f *rotationRecoveryFixture) error {
			return f.s.Put("instance-enrollments", f.scopes[0].InstanceID, "synthetic-corrupt-record")
		}},
		{"referenced-manifest-missing", func(f *rotationRecoveryFixture) error {
			return f.s.Remove("published-manifests", f.desired[0].RevisionID)
		}},
		{"referenced-manifest-identity", func(f *rotationRecoveryFixture) error {
			var manifest domain.PublishedManifest
			if err := f.s.Get("published-manifests", f.desired[0].RevisionID, &manifest); err != nil {
				return err
			}
			manifest.Identity.Generation++
			return f.s.Put("published-manifests", f.desired[0].RevisionID, manifest)
		}},
		{"referenced-route-entry-identity", func(f *rotationRecoveryFixture) error {
			var manifest domain.PublishedManifest
			if err := f.s.Get("published-manifests", f.desired[0].RevisionID, &manifest); err != nil {
				return err
			}
			for i := range manifest.Routes {
				if manifest.Routes[i].ID == "rotation-line" {
					manifest.Routes[i].Path.Entry = "nonexistent-entry"
				}
			}
			return f.s.Put("published-manifests", f.desired[0].RevisionID, manifest)
		}},
		{"referenced-route-empty-endpoints", func(f *rotationRecoveryFixture) error {
			var manifest domain.PublishedManifest
			if err := f.s.Get("published-manifests", f.desired[0].RevisionID, &manifest); err != nil {
				return err
			}
			for i := range manifest.Routes {
				if manifest.Routes[i].ID == "rotation-line" {
					manifest.Routes[i].EndpointIDs = nil
				}
			}
			return f.s.Put("published-manifests", f.desired[0].RevisionID, manifest)
		}},
		{"owned-output-decode", func(f *rotationRecoveryFixture) error {
			return f.s.TenantPut(f.owner.id, "outputs", "rotation-phone", "synthetic-corrupt-record")
		}},
		{"current-grant-decode", func(f *rotationRecoveryFixture) error {
			return f.s.TenantPut(f.owner.id, "platform-entries", "rotation-grant", "synthetic-corrupt-record")
		}},
		{"current-grant-connection-mismatch", func(f *rotationRecoveryFixture) error {
			var grant httpapi.PublicEntryGrant
			if err := f.s.TenantGet(f.owner.id, "platform-entries", "rotation-grant", &grant); err != nil {
				return err
			}
			grant.Connection.UUID = "22222222-2222-4222-8222-222222222222"
			return f.s.TenantPut(f.owner.id, "platform-entries", grant.ID, grant)
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			f := newRotationRecoveryFixture(t)
			output := f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "rotation-phone", "name": "Phone", "profileId": "rotation-profile"}, 201)
			// Deliberate repository-boundary fault injection only. The response
			// under test is the authenticated public HTTP seam, not a helper.
			if err := test.inject(f); err != nil {
				t.Fatal(err)
			}
			f.accessUnavailable("rotation-phone", test.name, 503)
			if strings.HasPrefix(test.name, "referenced-") {
				code, _, raw := req(t, f.admin, "GET", f.srv.URL+"/api/users/"+f.owner.id+"/entries/rotation-grant/reveal", "", nil)
				if code != 409 || strings.Contains(raw, "synthetic-corrupt-record") || strings.Contains(raw, "cannot unmarshal") || strings.Contains(raw, "instance-enrollments") || strings.Contains(raw, "published-manifests") {
					t.Fatalf("existing administrator reveal must retain safe unresolved-proof denial: status=%d", code)
				}
			}
			if test.name == "owned-output-decode" {
				// Other endpoints' initial record-read contracts are unchanged;
				// this case exercises the newly classified owner /access seam.
				return
			}
			for _, path := range []string{output["feedPath"].(string), output["downloadPath"].(string)} {
				client := http.DefaultClient
				if strings.HasPrefix(path, "/api/") {
					client = f.owner.c
				}
				code, _, raw := req(t, client, "GET", f.srv.URL+path, "", nil)
				if code != 403 || strings.Contains(raw, "synthetic-corrupt-record") || strings.Contains(raw, "cannot unmarshal") || strings.Contains(raw, "OUTPUT_") {
					t.Fatalf("final delivery must retain generic denial: status=%d", code)
				}
			}
		})
	}
}

func TestOutputRotationRecoveryPreservesKnownMissingProofAsUnconfirmed(t *testing.T) {
	for _, condition := range []string{"missing-observation", "expired-policy", "revoked-enrollment", "expired-enrollment"} {
		t.Run(condition, func(t *testing.T) {
			f := newRotationRecoveryFixture(t)
			f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "rotation-phone", "name": "Phone", "profileId": "rotation-profile"}, 201)
			var err error
			switch condition {
			case "missing-observation":
				err = f.s.Remove("agent-observations", f.scopes[0].InstanceID)
			case "expired-policy":
				var manifest domain.PublishedManifest
				if err = f.s.Get("published-manifests", f.desired[0].RevisionID, &manifest); err == nil {
					manifest.PolicyExpiresAt = time.Now().Add(-time.Second)
					err = f.s.Put("published-manifests", f.desired[0].RevisionID, manifest)
				}
			default:
				var enrollment httpapi.Enrollment
				if err = f.s.Get("instance-enrollments", f.scopes[0].InstanceID, &enrollment); err == nil {
					enrollment.Revoked = condition == "revoked-enrollment"
					if condition == "expired-enrollment" {
						enrollment.ExpiresAt = time.Now().Add(-time.Second)
					}
					err = f.s.Put("instance-enrollments", f.scopes[0].InstanceID, enrollment)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			f.accessBlocked("rotation-phone", "OUTPUT_ENTRY_UNCONFIRMED")
		})
	}
}

func TestOutputRotationRecoveryIgnoresUnrelatedMalformedObservationWhenPathIsProven(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	output := f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "rotation-phone", "name": "Phone", "profileId": "rotation-profile"}, 201)
	before := f.ownerRequest("GET", "/me/outputs/rotation-phone/access", nil, 200)
	if err := f.s.Put("agent-observations", "unrelated-corrupt-instance", "synthetic-corrupt-record"); err != nil {
		t.Fatal(err)
	}
	after := f.ownerRequest("GET", "/me/outputs/rotation-phone/access", nil, 200)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("unrelated malformed observation invalidated the exact positively confirmed path")
	}
	code, _, _ := req(t, http.DefaultClient, "GET", f.srv.URL+output["feedPath"].(string), "", nil)
	if code != 200 {
		t.Fatalf("unrelated malformed observation broke final delivery: %d", code)
	}
}

// Bearer authentication alone is not a persisted, enabled subscription owner.
// Exercise the public access endpoint without changing feed authorization.
func TestOutputAccessRequiresPersistedEnabledOwner(t *testing.T) {
	for _, tc := range []struct {
		name            string
		accountPresent  bool
		userPresent     bool
		accountDisabled bool
		userEnabled     bool
		wantStatus      int
	}{
		{"missing-account", false, true, false, true, 409},
		{"missing-user", true, false, false, true, 409},
		{"disabled-account", true, true, true, true, 409},
		{"disabled-user", true, true, false, false, 409},
		{"enabled-owner", true, true, false, true, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, srv := makeServer(t)
			if tc.accountPresent {
				if err := s.Put("accounts", "operator", store.Account{ID: "operator", Name: "Operator", Role: "admin", Disabled: tc.accountDisabled}); err != nil {
					t.Fatal(err)
				}
			}
			if tc.userPresent {
				if err := s.PutUser(domain.User{ID: "operator", Name: "Operator", Enabled: tc.userEnabled}); err != nil {
					t.Fatal(err)
				}
			}
			output := httpapi.Output{ID: "owner-access", Status: "published", Token: strings.Repeat("x", 43)}
			if err := s.TenantPut("operator", "outputs", output.ID, output); err != nil {
				t.Fatal(err)
			}
			code, access, raw := req(t, operatorClient(), "GET", srv.URL+"/api/me/outputs/"+output.ID+"/access", "", nil)
			if code != tc.wantStatus {
				t.Fatalf("access status=%d want=%d: %s", code, tc.wantStatus, raw)
			}
			if tc.wantStatus == 200 {
				if access["feedPath"] != "/feed/"+output.Token || access["feedURL"] != "/feed/"+output.Token {
					t.Fatalf("enabled owner did not receive subscription access: %s", raw)
				}
				return
			}
			want := map[string]any{"detail": "This subscription is currently unavailable. Please check your access."}
			if !reflect.DeepEqual(access, want) {
				t.Fatalf("unavailable owner must receive only the generic response: %s", raw)
			}
			if strings.Contains(raw, output.Token) || strings.Contains(raw, "/feed/") {
				t.Fatalf("unavailable owner response exposed subscription access: %s", raw)
			}
		})
	}
}
