package httpapi_test

import (
	"encoding/json"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestPlatformCertificatesAreReusableWithoutReturningPrivateKeys(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	user := inviteClient(t, s, srv, "certificate-reader")
	path := srv.URL + "/api/server-tls-certificates"
	if code, _, _ := req(t, user.c, "GET", path, "", nil); code != 403 {
		t.Fatalf("ordinary user accessed platform certificates: %d", code)
	}

	material, _ := publishedSyntheticTLS(t)
	program := domain.ServerProgram{
		Instance: domain.CoreInstance{ID: "core", HostID: "host", AdapterID: render.ServerAdapterSingBox, Version: render.StockSingBoxVersion},
		Listener: domain.ManagedEndpoint{ID: "entry", InstanceID: "core", Name: "Entry", Connection: domain.Connection{
			Protocol: "trojan", Host: "127.0.0.1", Port: 443, Password: "synthetic-password",
			TLS: &domain.TLSOptions{Enabled: true, ServerName: "tls-entry.example"},
		}},
		TLS: material,
	}
	source := httpapi.ServerDeployment{ID: "certificate-source", Name: "Existing path", IR: domain.ServerDeploymentIR{TopologyRevision: "v1", Programs: []domain.ServerProgram{program}}}
	if err := s.Put("server-deployments", source.ID, source); err != nil {
		t.Fatal(err)
	}
	code, _, raw := req(t, admin, "GET", path, "", nil)
	var certs []struct {
		ID       string   `json:"id"`
		Name     string   `json:"name"`
		DNSNames []string `json:"dnsNames"`
	}
	if code != 200 || strings.Contains(raw, "PEM") || strings.Contains(raw, "BEGIN") ||
		json.Unmarshal([]byte(raw), &certs) != nil || len(certs) != 1 || certs[0].Name != "tls-entry.example" || len(certs[0].DNSNames) != 1 || certs[0].DNSNames[0] != "tls-entry.example" {
		t.Fatal("unexpected certificate catalog or exposed material")
	}

	target := source
	target.ID = "certificate-target"
	target.IR.Programs = []domain.ServerProgram{program}
	target.IR.Programs[0].TLS = nil
	draft := struct {
		httpapi.ServerDeployment
		CertificateIDs map[string]string `json:"certificateIds"`
	}{target, map[string]string{"entry": "missing"}}
	if code, _, _ := req(t, admin, "POST", srv.URL+"/api/server-deployments", "", draft); code != 409 {
		t.Fatalf("missing certificate did not block save: %d", code)
	}
	draft.CertificateIDs["entry"] = certs[0].ID
	code, _, raw = req(t, admin, "POST", srv.URL+"/api/server-deployments", "", draft)
	if code != 200 || strings.Contains(raw, "BEGIN") {
		t.Fatal("certificate reuse failed or leaked material")
	}
	var saved httpapi.ServerDeployment
	if err := s.Get("server-deployments", target.ID, &saved); err != nil {
		t.Fatal(err)
	}
	selected := saved.IR.Programs[0].TLS
	if selected == nil || selected.CertificatePEM != material.CertificatePEM || selected.PrivateKeyPEM != material.PrivateKeyPEM {
		t.Fatal("selected pair was not incorporated into the saved path")
	}
	var retained json.RawMessage
	if err := s.Get("server-tls-certificates", certs[0].ID, &retained); err != nil {
		t.Fatal("certificate was not retained for subsequent use")
	}

	other, _ := publishedSyntheticTLS(t)
	code, uploaded, raw := req(t, admin, "POST", path, "", map[string]string{
		"certificatePem": other.CertificatePEM, "privateKeyPem": other.PrivateKeyPEM,
	})
	if code != 201 || strings.Contains(raw, "BEGIN") {
		t.Fatal("certificate upload failed or leaked material")
	}
	target.ID = "endpoint-certificate"
	target.IR.Programs[0].Listener.CertificateID = uploaded["id"].(string)
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/hosts", "", domain.Host{ID: "host", Name: "Host", Address: "127.0.0.1"}); code != 200 {
		t.Fatalf("host fixture: %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/core-instances", "", program.Instance); code != 200 {
		t.Fatalf("instance fixture: %d %s", code, raw)
	}
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/managed-endpoints", "", target.IR.Programs[0].Listener); code != 200 {
		t.Fatalf("endpoint with platform certificate: %d %s", code, raw)
	}
	target.IR.Programs[0].TLS = material
	if code, _, raw := req(t, admin, "POST", srv.URL+"/api/server-deployments", "", target); code != 200 {
		t.Fatalf("draft with endpoint certificate: %d %s", code, raw)
	}
	if err := s.Get("server-deployments", target.ID, &saved); err != nil {
		t.Fatal(err)
	}
	if tls := saved.IR.Programs[0].TLS; tls == nil || tls.CertificatePEM != other.CertificatePEM || tls.PrivateKeyPEM != other.PrivateKeyPEM {
		t.Fatal("deployment did not use the endpoint certificate")
	}

}
