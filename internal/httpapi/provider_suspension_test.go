package httpapi_test

import (
	"net/http"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"testing"
	"time"
)

func TestProviderSuspensionAdminConfigurationAndVisibleReason(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	user := inviteClient(t, s, srv, "provider-policy-viewer")
	for _, item := range []struct {
		kind, id string
		value    any
	}{
		{"hosts", "provider-host", domain.Host{ID: "provider-host", Name: "Provider host"}},
		{"core-instances", "provider-core", domain.CoreInstance{ID: "provider-core", HostID: "provider-host", AdapterID: "routeweaver/managed-xray"}},
	} {
		if err := s.Put(item.kind, item.id, item.value); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()
	cfg := observability.Config{BilledInterfaces: []string{}, Provider: &observability.ProviderConfig{Name: "Provider", Mode: "limited", Allowance: 1, Unit: "GB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: "provider_statement", ExhaustionAction: "suspend-managed"}}
	base := srv.URL + "/api/admin/nodes/provider-host/observability"
	if code, _, _ := req(t, http.DefaultClient, "PUT", base+"/config", "", cfg); code != 401 {
		t.Fatal("anonymous policy write", code)
	}
	if code, _, _ := req(t, user.c, "PUT", base+"/config", "", cfg); code != 403 {
		t.Fatal("tenant policy write", code)
	}
	if code, _, body := req(t, admin, "PUT", base+"/config", "", cfg); code != 200 {
		t.Fatalf("configure %d %s", code, body)
	}
	if code, _, _ := req(t, admin, "PUT", base+"/config", "", cfg); code != 409 {
		t.Fatal("stale revision write", code)
	}
	read := func(want string) {
		t.Helper()
		code, out, body := req(t, admin, "GET", base, "", nil)
		if code != 200 {
			t.Fatal(code, body)
		}
		p := out["provider"].(map[string]any)
		if p["managedAdmissionReason"] != want || p["exhaustionAction"] != "suspend-managed" {
			t.Fatal("operator policy reason", body)
		}
	}
	read("provider-usage-unknown")
	statement := observability.StatementInput{CycleID: "cycle", UsedBytes: 1000000000, ObservedAt: now, Reference: "synthetic operator-entered bill"}
	if code, _, body := req(t, admin, "POST", base+"/provider-statement", "", statement); code != 200 {
		t.Fatalf("statement %d %s", code, body)
	}
	read("provider-exhausted")
}
