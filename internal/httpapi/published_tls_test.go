package httpapi_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"testing"
	"time"

	"routeweaver/internal/domain"
)

// Trust is scoped to this synthetic client. Nothing is installed in the OS,
// and hostname/certificate validation remains enabled on the actual wire.
func publishedSyntheticTLS(t *testing.T) (*domain.ServerTLSOptions, *tls.Config) {
	t.Helper()
	caPublic, caKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Synthetic route test CA"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, caPublic, caKey)
	if err != nil {
		t.Fatal(err)
	}
	public, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "tls-entry.example"}, DNSNames: []string{"tls-entry.example"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, public, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})) {
		t.Fatal("synthetic CA parse failed")
	}
	material := &domain.ServerTLSOptions{CertificatePath: "tls/entry.pem", KeyPath: "tls/entry-key.pem", CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})), PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))}
	return material, &tls.Config{RootCAs: roots, ServerName: "tls-entry.example", MinVersion: tls.VersionTLS13}
}
func dialPublishedEntry(port int, config *tls.Config) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: time.Second}
	address := fmt.Sprintf("127.0.0.1:%d", port)
	if config != nil {
		return tls.DialWithDialer(dialer, "tcp", address, config)
	}
	return dialer.Dial("tcp", address)
}
