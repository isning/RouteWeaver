//go:build linux

package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
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

// Generated client -> password-TLS listener -> loopback origin. CA trust belongs only to
// this fixture. Parser success is deliberately tested separately from traffic.
func TestNativeHysteria2Loopback(t *testing.T) { nativePasswordTLSLoopback(t, "hysteria2") }
func TestNativeAnyTLSLoopback(t *testing.T)    { nativePasswordTLSLoopback(t, "anytls") }

func nativePasswordTLSLoopback(t *testing.T, protocol string) {
	t.Helper()
	if !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",sing-box,") {
		t.Skip("requires explicit local sing-box process opt-in")
	}
	serverBinary := filepath.Join(os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR"), "sing-box-"+render.StockSingBoxVersion+"-linux-amd64")
	clientBinary := os.Getenv("ROUTEWEAVER_SINGBOX_BIN")
	if clientBinary == "" {
		t.Fatal("requested password-TLS runtime gate requires exact compatibility client")
	}
	for _, scenario := range []string{"roundtrip-and-stop", "wrong-password", "wrong-server-name"} {
		t.Run(scenario, func(t *testing.T) {
			var hits atomic.Int64
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				io.WriteString(w, "password-tls-loopback-payload")
			}))
			defer origin.Close()
			var serverPort int
			if protocol == "hysteria2" {
				udp, err := net.ListenPacket("udp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				serverPort = udp.LocalAddr().(*net.UDPAddr).Port
				udp.Close()
			} else {
				listener, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				serverPort = listener.Addr().(*net.TCPAddr).Port
				listener.Close()
			}
			tcp, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			clientPort := tcp.Addr().(*net.TCPAddr).Port
			tcp.Close()
			caPath, certificate, key := loopbackCertificate(t)
			connection := domain.Connection{Protocol: protocol, Host: "127.0.0.1", Port: serverPort, Password: "synthetic-loopback-password", TLS: &domain.TLSOptions{Enabled: true, ServerName: "localhost"}}
			if protocol == "anytls" {
				connection.TLS.ALPN = []string{"http/1.1"}
			}
			program := domain.ServerProgram{Instance: domain.CoreInstance{ID: "server", HostID: "local-host", AdapterID: render.ServerAdapterSingBox, Version: render.StockSingBoxVersion}, Listener: domain.ManagedEndpoint{ID: "entry", InstanceID: "server", Name: "Fixture", Connection: connection}, DefaultAction: domain.ActionRef{Kind: "direct"}, TLS: &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: certificate, PrivateKeyPEM: key}}
			material, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "password-tls-loopback", TopologyRevision: "1", Programs: []domain.ServerProgram{program}})
			if err != nil {
				t.Fatal(err)
			}
			for i := range material {
				material[i].Path = strings.TrimPrefix(material[i].Path, "server/")
			}
			stopServer := passwordTLSRunOwned(t, "server", render.StockSingBoxVersion, serverBinary, material)
			if scenario == "wrong-password" {
				connection.Password = "incorrect-synthetic-password"
			}
			if scenario == "wrong-server-name" {
				connection.TLS = &domain.TLSOptions{Enabled: true, ServerName: "wrong.fixture.invalid"}
			}
			profile := domain.ClientProfileIR{SchemaVersion: "1.0", ID: "password-tls-client", Name: "Fixture", OwnerID: "fixture", Revision: "1", Endpoints: []domain.ClientEndpoint{{ID: "endpoint", Name: "Fixture", OwnerID: "fixture", Origin: "imported", Connection: connection}}, DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: "endpoint"}, Runtime: domain.ClientRuntime{MixedPort: clientPort}}
			rendered, err := render.DefaultClients().Render(profile, render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			var config map[string]any
			if err = json.Unmarshal([]byte(rendered.Artifacts[0].Content), &config); err != nil {
				t.Fatal(err)
			}
			// Only extend the test process's trust. Do not disable certificate checking.
			for _, raw := range config["outbounds"].([]any) {
				out := raw.(map[string]any)
				if out["type"] == protocol {
					out["tls"].(map[string]any)["certificate_path"] = "fixture-ca.pem"
				}
			}
			encoded, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			ca, err := os.ReadFile(caPath)
			if err != nil {
				t.Fatal(err)
			}
			passwordTLSRunOwned(t, "client", render.SingBoxVersion, clientBinary, []domain.Artifact{{Path: "config.json", Content: string(encoded)}, {Path: "fixture-ca.pem", Content: string(ca)}})
			proxyURL, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", clientPort))
			transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), DisableKeepAlives: true}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, Timeout: 4 * time.Second}
			request := func() (string, error) {
				resp, e := client.Get(origin.URL)
				if e != nil {
					return "", e
				}
				defer resp.Body.Close()
				body, e := io.ReadAll(resp.Body)
				if resp.StatusCode != 200 {
					return "", fmt.Errorf("proxy status %d", resp.StatusCode)
				}
				return string(body), e
			}
			body, err := request()
			if scenario != "roundtrip-and-stop" {
				if err == nil || hits.Load() != 0 {
					t.Fatalf("invalid credentials reached origin: body=%q error=%v hits=%d", body, err, hits.Load())
				}
				return
			}
			if err != nil || body != "password-tls-loopback-payload" || hits.Load() != 1 {
				t.Fatalf("password-TLS roundtrip failed: body=%q error=%v hits=%d", body, err, hits.Load())
			}
			stopServer()
			if body, err = request(); err == nil || hits.Load() != 1 {
				t.Fatalf("stopped server fell back to direct: body=%q error=%v hits=%d", body, err, hits.Load())
			}
		})
	}
}

func passwordTLSRunOwned(t *testing.T, id, version, binary string, material []domain.Artifact) func() {
	t.Helper()
	checker, err := agent.NewNativeChecker(render.ServerAdapterSingBox, version, binary, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := agent.NewProcessSupervisor(checker, agent.SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "private-agent")
	scope := agent.Scope{NodeID: "local-host", InstanceID: id, EnrollmentEpoch: "fixture-epoch"}
	reconciler, err := agent.Open(root, scope, agent.NewRegistry(supervisor), agent.Options{MaxLease: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	stop := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := supervisor.Stop(ctx, root); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { stop(); reconciler.Close() })
	digest, err := agent.ArtifactDigest(material)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	desired := agent.Desired{Scope: scope, AdapterID: render.ServerAdapterSingBox, CoreVersion: version, Generation: 1, RevisionID: "revision-one", OperationID: "apply-one", Digest: digest, EntryFile: "config.json", Artifacts: material, Lease: agent.PolicyLease{Revision: "policy-one", IssuedAt: now.Add(-time.Second), ExpiresAt: now.Add(5 * time.Minute), AccessAllowed: true, QuotaCertain: true}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	state, err := reconciler.Submit(ctx, desired)
	if err != nil || state.Phase != agent.ObservedConformant {
		t.Fatalf("password-TLS %s process activation failed (not a traffic pass): phase=%s error=%v", id, state.Phase, err)
	}
	return stop
}
