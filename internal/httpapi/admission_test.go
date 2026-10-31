package httpapi_test

import (
	"encoding/json"
	"net/http"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

type scopedAgentHTTP struct {
	scope controlprotocol.Scope
	token string
}

func (t scopedAgentHTTP) RoundTrip(r *http.Request) (*http.Response, error) {
	copy := r.Clone(r.Context())
	copy.Header.Set("Authorization", "Bearer "+t.token)
	copy.Header.Set("X-RouteWeaver-Node", t.scope.NodeID)
	copy.Header.Set("X-RouteWeaver-Enrollment", t.scope.EnrollmentEpoch)
	return http.DefaultTransport.RoundTrip(copy)
}
func TestAdmissionHTTPRequiresEnrolledEntryAndRevokesCredentialRenewal(t *testing.T) {
	s, srv := makeServer(t)
	user := inviteClient(t, s, srv, "admission-owner")
	admin := operatorClient()
	instance := domain.CoreInstance{ID: "instance", HostID: "host", AdapterID: render.ServerAdapterXray, Version: render.XrayVersion}
	for _, record := range []struct {
		kind, id string
		value    any
	}{
		{"core-instances", instance.ID, instance},
		{"managed-endpoints", "entry", domain.ManagedEndpoint{ID: "entry", InstanceID: instance.ID}},
		{"routes", "r", domain.Route{ID: "r", Name: "Service route"}},
		{"services", "plan", service.Plan{ID: "plan", Name: "Plan", RouteIDs: []string{"r"}, OnlineIPLimit: 1, EntryRateBPS: 2048, QuotaBytes: 0}},
		{"entitlements", user.id, service.Entitlement{UserID: user.id, ServiceID: "plan", Cycle: service.CyclePolicy{Mode: "none"}}},
	} {
		if e := s.Put(record.kind, record.id, record.value); e != nil {
			t.Fatal(e)
		}
	}
	grant := httpapi.PublicEntryGrant{ID: "grant", Name: "Public entry", RouteID: "r", CredentialVersion: "v1", Connection: domain.Connection{Host: "127.0.0.1", Port: 1080, Protocol: "socks", Username: "synthetic", Password: "synthetic-password"}}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/users/"+user.id+"/entries", "", grant); code != 201 {
		t.Fatalf("grant %d %s", code, raw)
	}
	binding := store.EntryAdmissionBinding{ID: "binding", EntryID: "entry", SubjectID: "subject", UserID: user.id, RouteID: "r", GrantID: grant.ID, CredentialVersion: "v1"}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/agent/instances/instance/entry-bindings", "", binding); code != 201 {
		t.Fatalf("binding %d %s", code, raw)
	}
	enroll := func() *http.Client {
		code, out, raw := req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": instance.HostID, "instanceId": instance.ID, "expiresAt": time.Now().Add(time.Hour)})
		if code != 201 {
			t.Fatalf("enroll %d %s", code, raw)
		}
		var scope controlprotocol.Scope
		b, _ := json.Marshal(out["scope"])
		if e := json.Unmarshal(b, &scope); e != nil {
			t.Fatal(e)
		}
		return &http.Client{Transport: scopedAgentHTTP{scope: scope, token: out["token"].(string)}}
	}
	agent := enroll()
	endpoint := srv.URL + "/api/agent/instances/instance/admission-leases"
	request := store.AdmissionRequest{EntryID: "entry", SubjectID: "subject", CredentialVersion: "v1", ClientIP: "192.0.2.1", PresenceID: "flow1"}
	if code, _, raw := req(t, user.c, "POST", endpoint, user.csrf, request); code != 401 {
		t.Fatalf("user impersonated native entry %d %s", code, raw)
	}
	code, lease, raw := req(t, agent, "POST", endpoint, "", request)
	if code != 200 || lease["allowed"] != true || lease["accountId"] != user.id || lease["routeId"] != "r" || lease["entryRateBps"] != float64(2048) {
		t.Fatalf("admit %d %s", code, raw)
	}
	leaseID := lease["leaseId"].(string)
	request.PresenceID = "flow2"
	request.ClientIP = "192.0.2.2"
	if code, lease, raw = req(t, agent, "POST", endpoint, "", request); code != 200 || lease["allowed"] != false || lease["reason"] != "ip-limit" {
		t.Fatalf("new IP %d %s", code, raw)
	}
	if code, _, raw = req(t, agent, "DELETE", endpoint+"/"+leaseID, "", nil); code != 204 {
		t.Fatalf("release %d %s", code, raw)
	}
	if code, lease, raw = req(t, agent, "POST", endpoint, "", request); code != 200 || lease["allowed"] != true {
		t.Fatalf("reclaim %d %s", code, raw)
	}
	if code, _, raw = req(t, admin, "DELETE", srv.URL+"/api/users/"+user.id+"/entries/grant", "", nil); code != 200 {
		t.Fatalf("credential revoke %d %s", code, raw)
	}
	if code, lease, raw = req(t, agent, "POST", endpoint, "", request); code != 200 || lease["allowed"] != false || lease["reason"] != "credential-revoked" {
		t.Fatalf("renew revoked grant %d %s", code, raw)
	}
	enroll()
	if code, _, raw = req(t, agent, "POST", endpoint, "", request); code != 401 {
		t.Fatalf("superseded node obtained lease %d %s", code, raw)
	}
	budgetURL := srv.URL + "/api/agent/instances/instance/admission-budgets"
	code, _, raw = req(t, admin, "GET", budgetURL, "", nil)
	var reviews []store.AdmissionBudgetReview
	if code != 200 || json.Unmarshal([]byte(raw), &reviews) != nil || len(reviews) != 2 {
		t.Fatalf("budget reviews %d %s", code, raw)
	}
	var review store.AdmissionBudgetReview
	for _, v := range reviews {
		if v.LeaseID == leaseID {
			review = v
		}
	}
	command := store.AdmissionBudgetResolution{LeaseID: review.LeaseID, ExpectedDigest: review.Digest, AdmittedBytes: 25, RuntimeStopped: true, Reason: "Synthetic stopped-runtime final receipt", Evidence: "isolated-final-fixture"}
	if code, _, raw = req(t, user.c, "POST", budgetURL+"/finalize", user.csrf, command); code != 403 {
		t.Fatalf("tenant final reconciliation %d %s", code, raw)
	}
	if code, _, raw = req(t, admin, "POST", budgetURL+"/finalize", "", command); code != 200 {
		t.Fatalf("reviewed final after reenrollment %d %s", code, raw)
	}
	if code, _, raw = req(t, admin, "POST", budgetURL+"/finalize", "", command); code != 409 {
		t.Fatalf("stale final replay not fenced %d %s", code, raw)
	}
	usage, e := s.Usage(user.id, time.Time{}, time.Time{})
	if e != nil || usage.RawBytes != 25 {
		t.Fatalf("reviewed measurement not recorded %+v %v", usage, e)
	}
}
