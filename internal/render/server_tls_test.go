package render_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"testing"
	"time"
)

func serverCertificate(t *testing.T) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	cert, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw}))
}
func TestServerTLSPackagesOnlyDeclaredMatchingKeyMaterial(t *testing.T) {
	certificate, key := serverCertificate(t)
	p := principalProgram(render.ServerAdapterManagedXray, render.ManagedXrayVersion)
	p.Listener.Connection.TLS = &domain.TLSOptions{Enabled: true, ServerName: "localhost"}
	p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: certificate, PrivateKeyPEM: key}
	ir := domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "tls-test", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}}
	artifacts, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]string{}
	for _, a := range artifacts {
		found[a.Path] = a.Content
	}
	if found["ingress/tls/cert.pem"] != certificate || found["ingress/tls/key.pem"] != key || len(found) != 4 {
		t.Fatal("declared TLS materials not packaged with config and sidecar")
	}
	_, wrongKey := serverCertificate(t)
	ir.Programs[0].TLS.PrivateKeyPEM = wrongKey
	if _, err = render.DefaultServers().Render(ir); err == nil {
		t.Fatal("mismatched server certificate and key accepted")
	}
	ir.Programs[0].TLS.PrivateKeyPEM = key
	ir.Programs[0].TLS.KeyPath = "config.json"
	if _, err = render.DefaultServers().Render(ir); err == nil {
		t.Fatal("TLS material overwrote runtime config")
	}
	ir.Programs[0].TLS.KeyPath = "../key.pem"
	if _, err = render.DefaultServers().Render(ir); err == nil {
		t.Fatal("TLS material escaped package")
	}
}
