//go:build linux

package integration_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

// This reuses the owned-process/reconciler harness. Destinations, listeners and
// certificate trust are fixture-local. It never changes the host trust store.
func TestNativeEndpointProtocolsLoopback(t *testing.T) {
	dir := os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR")
	if dir == "" || !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",xray,") {
		t.Skip("requires explicit local Xray process opt-in")
	}
	for _, protocol := range []string{"vmess", "trojan"} {
		for _, transport := range []string{"tcp", "ws", "httpupgrade", "grpc"} {
			t.Run(protocol+"/"+transport, func(t *testing.T) {
				endpointProtocolLoopback(t, dir, protocol, transport, stockLoopbackOptions{privateCIDRs: []string{"127.0.0.1/32"}, trustFixtureCA: true})
			})
		}
	}
}

type stockLoopbackOptions struct {
	privateCIDRs    []string
	destinationHost string
	trustFixtureCA  bool
	wrongServerName bool
	wantDenied      bool
}

func endpointProtocolLoopback(t *testing.T, dir, protocol, transport string, options stockLoopbackOptions) {
	t.Helper()
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	var accepted atomic.Int64
	go func() {
		for {
			c, e := echo.Accept()
			if e != nil {
				return
			}
			accepted.Add(1)
			go func() { defer c.Close(); c.SetDeadline(time.Now().Add(5 * time.Second)); io.Copy(c, c) }()
		}
	}()
	port := func() int {
		l, e := net.Listen("tcp", "127.0.0.1:0")
		if e != nil {
			t.Fatal(e)
		}
		defer l.Close()
		return l.Addr().(*net.TCPAddr).Port
	}
	entryPort, exitPort := port(), port()
	caPath, certificate, key := "", "", ""
	if protocol == "trojan" {
		caPath, certificate, key = loopbackCertificate(t)
	}
	connection := func() domain.Connection {
		c := domain.Connection{Host: "127.0.0.1", Port: exitPort, Protocol: protocol, Transport: &domain.TransportOptions{Type: transport}}
		if protocol == "trojan" {
			c.Password = "synthetic-loopback-password"
			c.TLS = &domain.TLSOptions{Enabled: true, ServerName: "localhost"}
			if options.wrongServerName {
				c.TLS.ServerName = "wrong.fixture.invalid"
			}
		} else {
			c.UUID = "00000000-0000-4000-8000-000000000001"
			c.VMessSecurity = "auto"
		}
		switch transport {
		case "ws", "httpupgrade":
			c.Transport.Path = "/proxy-safe_1"
			c.Transport.Host = "loopback.invalid"
		case "grpc":
			c.Transport.ServiceName = "loopback"
		}
		return c
	}
	program := func(id string, c domain.Connection) domain.ServerProgram {
		return domain.ServerProgram{Instance: domain.CoreInstance{ID: id, HostID: "local-host", AdapterID: render.ServerAdapterXray, Version: render.StockXrayVersion}, Listener: domain.ManagedEndpoint{ID: id + "-entry", InstanceID: id, Name: id, Connection: c}}
	}
	exit := program("exit", connection())
	if len(options.privateCIDRs) > 0 {
		exit.DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: options.privateCIDRs}
	}
	if protocol == "trojan" {
		exit.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: certificate, PrivateKeyPEM: key}
	}
	entry := program("entry", domain.Connection{Host: "127.0.0.1", Port: entryPort, Protocol: "socks", Username: "fixture", Password: "local-only"})
	outbound := connection()
	if transport == "ws" || transport == "httpupgrade" {
		outbound.Transport.Headers = map[string]string{"X-Loopback-Fixture": "synthetic-request-header"}
	}
	entry.Egress = []domain.Connection{outbound}
	artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "loopback-route", TopologyRevision: "1", Programs: []domain.ServerProgram{exit, entry}})
	if err != nil {
		t.Fatal(err)
	}
	if options.trustFixtureCA && caPath != "" {
		artifacts = stockFixtureCATrust(t, artifacts, caPath)
	}
	grouped := map[string][]domain.Artifact{}
	for _, a := range artifacts {
		id, relative, ok := strings.Cut(a.Path, "/")
		if !ok {
			t.Fatal("artifact not instance-scoped")
		}
		grouped[id] = append(grouped[id], domain.Artifact{Path: relative, Content: a.Content})
	}
	var exitSupervisor *agent.ProcessSupervisor
	var exitRoot string
	for _, id := range []string{"exit", "entry"} {
		binary := filepath.Join(dir, "xray-26.10.31-linux-amd64")
		checker, err := agent.NewNativeChecker(render.ServerAdapterXray, render.StockXrayVersion, binary, 5*time.Second)

		if err != nil {
			t.Fatal(err)
		}
		supervisor, err := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
		if err != nil {
			t.Fatal(err)
		}
		root := filepath.Join(t.TempDir(), "private-agent")
		if id == "exit" {
			exitSupervisor = supervisor
			exitRoot = root
		}
		scope := agent.Scope{NodeID: "local-host", InstanceID: id, EnrollmentEpoch: "fixture-epoch"}
		reconciler, err := agent.Open(root, scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: time.Hour})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := supervisor.Stop(ctx, root); err != nil {
				t.Error(err)
			}
			reconciler.Close()
		})
		now := time.Now()
		digest, err := agent.ArtifactDigest(grouped[id])
		if err != nil {
			t.Fatal(err)
		}
		desired := agent.Desired{Scope: scope, AdapterID: render.ServerAdapterXray, CoreVersion: render.StockXrayVersion, Generation: 1, RevisionID: "revision-one", OperationID: "apply-one", Digest: digest, EntryFile: "config.json", Artifacts: grouped[id], Lease: agent.PolicyLease{Revision: "policy-one", IssuedAt: now.Add(-time.Second), ExpiresAt: now.Add(5 * time.Minute), AccessAllowed: true, QuotaCertain: true}}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		state, err := reconciler.Submit(ctx, desired)
		cancel()
		if err != nil || state.Phase != agent.ObservedConformant {
			t.Fatalf("loopback apply failed: %s %v", state.Phase, err)
		}
	}
	destinationHost := options.destinationHost
	if destinationHost == "" {
		destinationHost = "127.0.0.1"
	}
	c, err := socksConnectDestination(fmt.Sprintf("127.0.0.1:%d", entryPort), destinationHost, echo.Addr().(*net.TCPAddr).Port)
	if options.wantDenied {
		if err == nil {
			defer c.Close()
			if _, err = io.WriteString(c, "must-not-reach-origin"); err == nil {
				_, err = io.ReadFull(c, make([]byte, len("must-not-reach-origin")))
			}
		}
		if err == nil || accepted.Load() != 0 {
			t.Fatalf("security default or exception boundary allowed origin traffic: err=%v originConnections=%d", err, accepted.Load())
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	payload := "bounded-loopback-" + protocol + "-" + transport
	if _, err = io.WriteString(c, payload); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(payload))
	if _, err = io.ReadFull(c, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != payload {
		t.Fatal("loopback payload mismatch")
	}
	c.Close()
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*time.Second)
	err = exitSupervisor.Stop(stopCtx, exitRoot)
	stopCancel()
	if err != nil {
		t.Fatal(err)
	}
	// Echo remains available. A fresh successful payload now would demonstrate
	// an unintended direct fallback rather than use of the selected protocol.
	bypass, bypassErr := socksConnectDestination(fmt.Sprintf("127.0.0.1:%d", entryPort), destinationHost, echo.Addr().(*net.TCPAddr).Port)
	if bypassErr == nil {
		defer bypass.Close()
		if _, bypassErr = io.WriteString(bypass, payload); bypassErr == nil {
			_, bypassErr = io.ReadFull(bypass, make([]byte, len(payload)))
		}
		if bypassErr == nil {
			t.Fatal("exit stopped but fresh payload bypassed protocol hop")
		}
	}
}

func loopbackCertificate(t *testing.T) (string, string, string) {
	t.Helper()
	now := time.Now()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "RouteWeaver ephemeral loopback CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	caPath := filepath.Join(t.TempDir(), "loopback-ca.pem")
	if err = os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0600); err != nil {
		t.Fatal(err)
	}
	return caPath, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
}
