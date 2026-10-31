package httpapi_test

import (
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"strings"
	"testing"
)

func TestServerInventoryAndDeploymentSecretsRequireExplicitAdminReveal(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	tenant := inviteClient(t, s, srv, "summary-reader")
	endpoint := domain.ManagedEndpoint{ID: "entry-redaction", InstanceID: "instance-redaction", Name: "Masked listener", Connection: domain.Connection{Host: "127.0.0.1", Port: 1080, Protocol: "socks", Username: "secret-admin-user", Password: "secret-admin-pass"}}
	ir := domain.ServerDeploymentIR{ID: "deployment-redaction", SchemaVersion: "1.0", Programs: []domain.ServerProgram{{Listener: endpoint, TLS: &domain.ServerTLSOptions{PrivateKeyPEM: "secret-server-pem", CertificatePEM: "secret-certificate-fixture", Reality: &domain.ServerRealityOptions{PrivateKey: "secret-reality-key", ShortIDs: []string{"secret-reality-id"}}}}}}
	endpoint.Connection.Transport = &domain.TransportOptions{Type: "ws", Headers: map[string]string{"X-Token": "secret-transport-header"}}
	ir.Programs[0].Listener = endpoint
	if e := s.Put("managed-endpoints", endpoint.ID, endpoint); e != nil {
		t.Fatal(e)
	}
	if e := s.Put("server-deployments", ir.ID, httpapi.ServerDeployment{ID: ir.ID, Name: "Secret fixture", IR: ir}); e != nil {
		t.Fatal(e)
	}
	for _, item := range []struct{ kind, id string }{{"managed-endpoints", endpoint.ID}, {"server-deployments", ir.ID}} {
		for _, suffix := range []string{"", "/" + item.id} {
			code, _, raw := req(t, admin, "GET", srv.URL+"/api/"+item.kind+suffix, "", nil)
			if code != 200 || strings.Contains(raw, "secret-") {
				t.Fatalf("summary leaked or failed %d %s", code, raw)
			}
		}
		code, _, raw := req(t, admin, "GET", srv.URL+"/api/"+item.kind+"/"+item.id+"/reveal", "", nil)
		if code != 200 || (!strings.Contains(raw, "secret-admin-pass") || !strings.Contains(raw, "secret-transport-header")) {
			t.Fatalf("explicit reveal failed %d %s", code, raw)
		}
		code, _, _ = req(t, tenant.c, "GET", srv.URL+"/api/"+item.kind+"/"+item.id+"/reveal", "", nil)
		if code != 403 {
			t.Fatalf("tenant can reveal admin secret: %d", code)
		}
	}
	var unchanged httpapi.ServerDeployment
	if e := s.Get("server-deployments", ir.ID, &unchanged); e != nil || unchanged.IR.Programs[0].TLS.PrivateKeyPEM != "secret-server-pem" {
		t.Fatal("summary mutated stored TLS key")
	}
}
