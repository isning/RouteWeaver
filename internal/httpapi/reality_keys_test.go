package httpapi_test

import (
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestEndpointRealityKeysAndDeployment(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	tenant := inviteClient(t, s, srv, "reality-reader")
	post := func(path string, body any) map[string]any {
		t.Helper()
		code, out, raw := req(t, admin, "POST", srv.URL+"/api/"+path, "", body)
		if code != 200 {
			t.Fatalf("POST %s failed (%d): %s", path, code, raw)
		}
		return out
	}
	if status, _, _ := req(t, tenant.c, "POST", srv.URL+"/api/managed-endpoints/reality-keys", tenant.csrf, nil); status != 403 {
		t.Fatalf("tenant reached the key generator: %d", status)
	}
	keys := post("managed-endpoints/reality-keys", nil)
	privateKey, publicKey, shortID := keys["privateKey"].(string), keys["publicKey"].(string), keys["shortId"].(string)
	host := domain.Host{ID: "host-reality", Name: "Host", Address: "127.0.0.1"}
	instance := domain.CoreInstance{ID: "core-reality", HostID: host.ID, AdapterID: render.ServerAdapterXray, Version: render.StockXrayVersion}
	endpoint := domain.ManagedEndpoint{
		ID: "reality-entry", InstanceID: instance.ID, Name: "Entry", Authentication: "principals",
		Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 1443, TLS: &domain.TLSOptions{
			Enabled: true, ServerName: "target.example", Fingerprint: "chrome", Reality: &domain.RealityOptions{PublicKey: publicKey, ShortID: shortID},
		}},
		Reality: &domain.ServerRealityOptions{PrivateKey: privateKey, HandshakeServer: "target.example", HandshakePort: 443, ServerNames: []string{"target.example"}, ShortIDs: []string{shortID}},
	}
	post("hosts", host)
	post("core-instances", instance)
	post("managed-endpoints", endpoint)
	_, _, raw := req(t, admin, "GET", srv.URL+"/api/managed-endpoints/"+endpoint.ID, "", nil)
	if strings.Contains(raw, privateKey) {
		t.Fatal("endpoint summary exposed its private key")
	}
	post("server-deployments", httpapi.ServerDeployment{ID: "reality-draft", Name: "Draft", IR: domain.ServerDeploymentIR{TopologyRevision: "v1", Programs: []domain.ServerProgram{{Instance: instance, Listener: endpoint}}}})
	var saved httpapi.ServerDeployment
	if err := s.Get("server-deployments", "reality-draft", &saved); err != nil {
		t.Fatal(err)
	}
	program := saved.IR.Programs[0]
	if len(saved.Diagnostics) != 0 || program.TLS == nil || program.TLS.Reality == nil || program.TLS.Reality.PrivateKey != privateKey {
		t.Fatal("endpoint REALITY credentials did not become a valid deployment snapshot")
	}
}
