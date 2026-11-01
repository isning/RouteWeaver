package httpapi_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"math/big"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestServerPublicationRejectsUnusablePackagedCertificate(t *testing.T) {
	for _, kind := range []string{"expired", "not-yet-valid", "wrong-SNI"} {
		t.Run(kind, func(t *testing.T) {
			f := newFleetFixture(t)
			var d httpapi.ServerDeployment
			if e := f.s.Get("server-deployments", f.in.DeploymentID, &d); e != nil {
				t.Fatal(e)
			}
			now := time.Now()
			pub, key, e := ed25519.GenerateKey(rand.Reader)
			if e != nil {
				t.Fatal(e)
			}
			cert := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"expected.example"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
			switch kind {
			case "expired":
				cert.NotAfter = now.Add(-time.Minute)
			case "not-yet-valid":
				cert.NotBefore = now.Add(time.Minute)
			case "wrong-SNI":
				cert.DNSNames = []string{"other.example"}
			}
			der, e := x509.CreateCertificate(rand.Reader, cert, cert, pub, key)
			if e != nil {
				t.Fatal(e)
			}
			priv, e := x509.MarshalPKCS8PrivateKey(key)
			if e != nil {
				t.Fatal(e)
			}
			leaf, e := x509.ParseCertificate(der)
			if e != nil {
				t.Fatal(e)
			}
			roots := x509.NewCertPool()
			roots.AddCert(leaf)
			if _, e = leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: "expected.example", CurrentTime: now}); e == nil {
				t.Fatal("negative TLS fixture unexpectedly verifies")
			}
			t.Logf("actual x509 verification rejects this fixture: %v", e)
			p := &d.IR.Programs[0]
			p.Listener.Connection = domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 22000, UUID: "00112233-4455-6677-8899-aabbccddeeff", TLS: &domain.TLSOptions{Enabled: true, ServerName: "expected.example"}}
			p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: priv}))}
			f.updateEndpoint(t, p.Listener)
			f.saveDeployment(t, d)
			opened := openServerDraft(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+d.ID)
			v := requireServerValidation(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+d.ID, opened["revisionToken"].(string))
			code, result, raw := req(t, operatorClient(), "POST", f.srv.URL+"/api/server-deployments/"+d.ID+"/publish", "", map[string]any{"operationId": "publish-tls", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": v["fingerprint"]})
			detail := map[string]string{
				"expired":       "TLS certificate chain has expired; replace server TLS material and review again.",
				"not-yet-valid": "TLS certificate chain is not yet valid; correct server TLS material and review again.",
				"wrong-SNI":     "TLS certificate does not cover an intended server name; correct the certificate or endpoint and review again.",
			}[kind]
			if code != 200 || result["status"] != "definitively-rejected" || result["code"] != "PUBLICATION_REJECTED" || result["detail"] != detail {
				t.Fatalf("publication accepted known unusable %s certificate or lost actionable refusal: HTTP%d %s", kind, code, raw)
			}
			assertPublicationTLSRefusalDidNotQueue(t, f, raw)
		})
	}
}

func TestServerPublicationChecksPublicAndConnectorTLSNames(t *testing.T) {
	for _, kind := range []string{"public-host-fallback", "connector-server-name", "connector-host-fallback", "private-issuer-positive"} {
		t.Run(kind, func(t *testing.T) {
			f := newFleetFixture(t)
			d := configurePublicationTLS(t, f, time.Now().Add(time.Hour), false)
			p := &d.IR.Programs[0]
			if kind == "public-host-fallback" {
				p.Listener.Connection.TLS.ServerName = ""
			}
			if strings.HasPrefix(kind, "connector-") {
				connection := p.Listener.Connection
				connection.TLS = &domain.TLSOptions{Enabled: true, ServerName: "other.example"}
				if kind == "connector-host-fallback" {
					connection.TLS.ServerName = ""
				}
				d.IR.Programs[1].Connectors = []domain.ServerConnector{{ID: "target", Connection: connection}}
				d.IR.Programs[1].DefaultAction = domain.ActionRef{Kind: "forward", Ref: "target"}
			}
			f.updateEndpoint(t, p.Listener)
			f.saveDeployment(t, d)
			if kind == "public-host-fallback" {
				f.post(t, "published-routes", map[string]any{"id": "tls-route", "name": "TLS route", "deploymentId": d.ID, "endpointIds": []string{p.Listener.ID}, "publicHost": "other.example", "publicPort": 443}, 200)
			}
			opened := openServerDraft(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+d.ID)
			v := requireServerValidation(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+d.ID, opened["revisionToken"].(string))
			code, result, raw := req(t, operatorClient(), "POST", f.srv.URL+"/api/server-deployments/"+d.ID+"/publish", "", map[string]any{"operationId": "publish-tls", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": v["fingerprint"]})
			if kind == "private-issuer-positive" {
				if code != 200 || result["status"] != "publication-accepted" || result["nativeChecked"] != false {
					t.Fatalf("deliberate private issuer rejected: %d %s", code, raw)
				}
			} else {
				if code != 200 || result["status"] != "definitively-rejected" || result["code"] != "PUBLICATION_REJECTED" || result["detail"] != "TLS certificate does not cover an intended server name; correct the certificate or endpoint and review again." {
					t.Fatalf("unusable TLS name accepted or unclear error: %d %s", code, raw)
				}
				assertPublicationTLSRefusalDidNotQueue(t, f, raw)
			}
		})
	}
}

func TestServerPublicationRejectsExpiredPackagedChain(t *testing.T) {
	f := newFleetFixture(t)
	d := configurePublicationTLS(t, f, time.Now().Add(-time.Minute), true)
	f.updateEndpoint(t, d.IR.Programs[0].Listener)
	f.saveDeployment(t, d)
	opened := openServerDraft(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+d.ID)
	v := requireServerValidation(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+d.ID, opened["revisionToken"].(string))
	code, result, raw := req(t, operatorClient(), "POST", f.srv.URL+"/api/server-deployments/"+d.ID+"/publish", "", map[string]any{"operationId": "publish-tls", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": v["fingerprint"]})
	if code != 200 || result["status"] != "definitively-rejected" || result["code"] != "PUBLICATION_REJECTED" || result["detail"] != "TLS certificate chain has expired; replace server TLS material and review again." {
		t.Fatalf("expired supplied issuer accepted: %d %s", code, raw)
	}
	assertPublicationTLSRefusalDidNotQueue(t, f, raw)
}

// Safe public refusal text must not trade away the original TLS enforcement.
func assertPublicationTLSRefusalDidNotQueue(t *testing.T, f fleetFixture, raw string) {
	t.Helper()
	for _, private := range []string{"expected.example", "other.example", "BEGIN CERTIFICATE", "PRIVATE KEY"} {
		if strings.Contains(raw, private) {
			t.Fatalf("publication receipt exposed TLS input: %s", raw)
		}
	}
	for _, id := range f.in.TargetIDs {
		var desired controlprotocol.Desired
		if err := f.s.Get("agent-desired", id, &desired); err != store.ErrNotFound {
			t.Fatalf("TLS refusal queued desired for %s: %+v %v", id, desired, err)
		}
	}
	manifests, err := f.s.List("published-manifests")
	if err != nil || len(manifests) != 0 {
		t.Fatalf("TLS refusal wrote manifests: %d %v", len(manifests), err)
	}
}

func TestFleetPublicationRechecksTLSForAllActivatingActions(t *testing.T) {
	f := newFleetFixture(t)
	until := time.Now().Add(3 * time.Second).Truncate(time.Second)
	d := configurePublicationTLS(t, f, until, false)
	f.updateEndpoint(t, d.IR.Programs[0].Listener)
	f.saveDeployment(t, d)
	baseline := f.create(t)
	for i, id := range f.in.TargetIDs {
		f.post(t, "admin/fleet-batches/"+baseline+"/execute", map[string]any{"stage": i, "requestId": fmt.Sprintf("initial-%d", i)}, 200)
		f.observe(t, id, controlprotocol.ObservedConformant)
	}
	// This batch was reviewed while valid, but execution must check again.
	pending := f.create(t)
	time.Sleep(time.Until(until.Add(20 * time.Millisecond)))
	code, _, raw := req(t, operatorClient(), "POST", f.srv.URL+"/api/admin/fleet-batches/"+pending+"/execute", "", map[string]any{"stage": 0, "requestId": "expired"})
	if code != 200 || !strings.Contains(raw, `"status":"failed"`) || !strings.Contains(raw, `"code":"review_required"`) {
		t.Fatalf("reviewed batch did not fail closed on expired TLS: %d %s", code, raw)
	}
	var desired controlprotocol.Desired
	if err := f.s.Get("agent-desired", "fleet-a", &desired); err != nil || desired.Generation != 1 {
		t.Fatalf("expired reviewed batch changed the queued generation: %+v %v", desired, err)
	}
	for _, action := range []string{"configure", "start", "rollback", "upgrade", "install"} {
		in := f.in
		in.Action = action
		if action == "rollback" {
			in.SourceBatchID = baseline
		}
		if action == "upgrade" || action == "install" {
			in.TargetReleaseID = "xray-26.10.31-linux-amd64"
		}
		code, _, raw := req(t, operatorClient(), "POST", f.srv.URL+"/api/admin/fleet-batches/preview", "", in)
		if code != 422 || !strings.Contains(raw, "expired") {
			t.Fatalf("%s bypassed TLS gate: %d %s", action, code, raw)
		}
	}
}

// A leaf-only private certificate is intentional. With includeCA, the valid leaf
// is signed by a supplied issuer whose expiry is independently testable.
func configurePublicationTLS(t *testing.T, f fleetFixture, expiry time.Time, includeCA bool) httpapi.ServerDeployment {
	t.Helper()
	var d httpapi.ServerDeployment
	if err := f.s.Get("server-deployments", f.in.DeploymentID, &d); err != nil {
		t.Fatal(err)
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"expected.example"}, NotBefore: now.Add(-time.Hour), NotAfter: expiry, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	parent, signer := cert, key
	var caDER []byte
	if includeCA {
		caPublic, caKey, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		parent = &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: now.Add(-time.Hour), NotAfter: expiry, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
		caDER, err = x509.CreateCertificate(rand.Reader, parent, parent, caPublic, caKey)
		if err != nil {
			t.Fatal(err)
		}
		signer = caKey
		cert.NotAfter = now.Add(time.Hour)
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, parent, pub, signer)
	if err != nil {
		t.Fatal(err)
	}
	priv, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if includeCA {
		certPEM = append(certPEM, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})...)
	}
	p := &d.IR.Programs[0]
	p.Listener.Connection = domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 22000, UUID: "00112233-4455-6677-8899-aabbccddeeff", TLS: &domain.TLSOptions{Enabled: true, ServerName: "expected.example"}}
	p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: string(certPEM), PrivateKeyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: priv}))}
	return d
}
