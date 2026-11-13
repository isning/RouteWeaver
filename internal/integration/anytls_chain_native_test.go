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
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

// Independently owned processes exercise named connectors, not flattened
// egress. Restarting the entry after stopping transit discards AnyTLS sessions.
func TestNativeAnyTLSViaSOCKSLoopback(t *testing.T)     { nativeAnyTLSViaLoopback(t, "socks") }
func TestNativeAnyTLSViaTrojanLoopback(t *testing.T)    { nativeAnyTLSViaLoopback(t, "trojan") }
func TestNativeAnyTLSViaTwoTrojanLoopback(t *testing.T) { nativeAnyTLSViaLoopback(t, "trojan2") }
func TestNativeAnyTLSViaVLESSLoopback(t *testing.T)     { nativeAnyTLSViaLoopback(t, "vless") }
func nativeAnyTLSViaLoopback(t *testing.T, relay string) {
	t.Helper()
	if !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",sing-box,") {
		t.Skip("requires explicit local sing-box process opt-in")
	}
	if relay != "socks" && !strings.Contains(","+os.Getenv("ROUTEWEAVER_NATIVE_PROCESS_TESTS")+",", ",xray,") {
		t.Skip("requires explicit Xray relay process opt-in")
	}
	binary := filepath.Join(os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR"), "sing-box-"+render.StockSingBoxVersion+"-linux-amd64")
	caPath, certificate, key := loopbackCertificate(t)
	port := func() int {
		l, e := net.Listen("tcp", "127.0.0.1:0")
		if e != nil {
			t.Fatal(e)
		}
		defer l.Close()
		return l.Addr().(*net.TCPAddr).Port
	}
	entryPort, transitPort, exitPort := port(), port(), port()
	socks := func(p int) domain.Connection {
		return domain.Connection{Protocol: "socks", Host: "127.0.0.1", Port: p, Username: "fixture", Password: "local-only"}
	}
	anytls := domain.Connection{Protocol: "anytls", Host: "127.0.0.1", Port: exitPort, Password: "synthetic-chain-password", TLS: &domain.TLSOptions{Enabled: true, ServerName: "localhost"}}
	program := func(id string, c domain.Connection) domain.ServerProgram {
		return domain.ServerProgram{Instance: domain.CoreInstance{ID: id, HostID: "local-host", AdapterID: render.ServerAdapterSingBox, Version: render.StockSingBoxVersion}, Listener: domain.ManagedEndpoint{ID: id + "-listener", InstanceID: id, Name: id, Connection: c}, DefaultAction: domain.ActionRef{Kind: "direct"}}
	}
	exit := program("exit", anytls)
	exit.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: certificate, PrivateKeyPEM: key}
	transit := program("transit", socks(transitPort))
	if relay != "socks" {
		transit.Listener.Connection = domain.Connection{Protocol: "trojan", Host: "127.0.0.1", Port: transitPort, Password: "synthetic-relay-password", TLS: &domain.TLSOptions{Enabled: true, ServerName: "localhost"}}
		transit.Instance.AdapterID = render.ServerAdapterXray
		transit.Instance.Version = render.StockXrayVersion
		transit.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem", CertificatePEM: certificate, PrivateKeyPEM: key}
		// Only this loopback fixture permits the private AnyTLS endpoint.
		transit.DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}
	}
	if relay == "vless" {
		transit.Listener.Connection.Protocol = "vless"
		transit.Listener.Connection.Password = ""
		transit.Listener.Connection.UUID = "00000000-0000-4000-8000-000000000091"
	}
	entry := program("entry", socks(entryPort))
	entry.Connectors = []domain.ServerConnector{{ID: "a-anytls", Via: "z-relay", Connection: anytls}, {ID: "z-relay", Connection: transit.Listener.Connection}}
	entry.DefaultAction = domain.ActionRef{Kind: "forward", Ref: "a-anytls"}
	programs := []domain.ServerProgram{exit, transit}
	if relay == "trojan2" {
		first := transit
		first.Instance.ID = "first-relay"
		first.Listener.ID = "first-relay-listener"
		first.Listener.InstanceID = "first-relay"
		first.Listener.Connection.Port = port()
		first.Listener.Connection.Password = "synthetic-first-relay-password"
		entry.Connectors[1].Via = "m-first-relay"
		entry.Connectors = append(entry.Connectors, domain.ServerConnector{ID: "m-first-relay", Connection: first.Listener.Connection})
		programs = append(programs, first)
	}
	programs = append(programs, entry)
	material, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "anytls-chain", TopologyRevision: "1", Programs: programs})
	if err != nil {
		t.Fatal(err)
	}
	grouped := map[string][]domain.Artifact{}
	for _, a := range material {
		id, path, ok := strings.Cut(a.Path, "/")
		if !ok {
			t.Fatal("unscoped artifact")
		}
		grouped[id] = append(grouped[id], domain.Artifact{Path: path, Content: a.Content})
	}
	ca, err := os.ReadFile(caPath)
	if err != nil {
		t.Fatal(err)
	}
	for i, a := range grouped["entry"] {
		if a.Path != "config.json" {
			continue
		}
		var config map[string]any
		if err = json.Unmarshal([]byte(a.Content), &config); err != nil {
			t.Fatal(err)
		}
		for _, raw := range config["outbounds"].([]any) {
			out := raw.(map[string]any)
			if out["type"] == "anytls" {
				if out["detour"] != "z-relay" {
					t.Fatal("named detour lost")
				}
			}
			if out["type"] == "anytls" || out["type"] == "trojan" || out["type"] == "vless" {
				out["tls"].(map[string]any)["certificate_path"] = "fixture-ca.pem"
			}
		}
		b, e := json.Marshal(config)
		if e != nil {
			t.Fatal(e)
		}
		grouped["entry"][i].Content = string(b)
	}
	grouped["entry"] = append(grouped["entry"], domain.Artifact{Path: "fixture-ca.pem", Content: string(ca)})
	transitBinary := binary
	if relay != "socks" {
		transitBinary = filepath.Join(os.Getenv("ROUTEWEAVER_STOCK_CORE_BIN_DIR"), "xray-"+render.StockXrayVersion+"-linux-amd64")
	}
	// Start Xray relays before sing-box so their own parser/startup is checked.
	stages := []string{"transit"}
	if relay == "trojan2" {
		stages = append(stages, "first-relay")
	}
	stages = append(stages, "exit")
	startStage := func(id string) func() {
		if id == "exit" {
			return passwordTLSRunOwned(t, id, render.StockSingBoxVersion, binary, grouped[id])
		}
		return passwordTLSRunOwnedAdapter(t, id, transit.Instance.AdapterID, transit.Instance.Version, transitBinary, grouped[id])
	}
	stops := map[string]func(){}
	for _, id := range stages {
		stops[id] = startStage(id)
	}
	stopEntry := passwordTLSRunOwned(t, "entry", render.StockSingBoxVersion, binary, grouped["entry"])
	var hits atomic.Int64
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		io.WriteString(w, "anytls-via-relay-payload")
	}))
	defer origin.Close()
	transport := &http.Transport{DisableKeepAlives: true, DialContext: func(_ context.Context, network, address string) (net.Conn, error) {
		host, p, e := net.SplitHostPort(address)
		if e != nil {
			return nil, e
		}
		n, e := strconv.Atoi(p)
		if e != nil {
			return nil, e
		}
		return socksConnectDestination(fmt.Sprintf("127.0.0.1:%d", entryPort), host, n)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 4 * time.Second}
	request := func() (string, error) {
		r, e := client.Get(origin.URL)
		if e != nil {
			return "", e
		}
		defer r.Body.Close()
		b, e := io.ReadAll(r.Body)
		return string(b), e
	}
	if body, e := request(); e != nil || body != "anytls-via-relay-payload" || hits.Load() != 1 {
		t.Fatalf("named chain roundtrip: body=%q error=%v hits=%d", body, e, hits.Load())
	}
	anyTLSChainUDP(t, fmt.Sprintf("127.0.0.1:%d", entryPort))
	// Each stopped peer must independently break the route. Fresh entries
	// discard AnyTLS sessions; full restoration proves no prior failure lingers.
	for i, id := range stages {
		before := hits.Load()
		stopEntry()
		stops[id]()
		stopEntry = passwordTLSRunOwned(t, fmt.Sprintf("negative-entry-%d", i), render.StockSingBoxVersion, binary, grouped["entry"])
		if body, e := request(); e == nil || hits.Load() != before {
			t.Fatalf("stopped %s bypassed: body=%q error=%v hits=%d", id, body, e, hits.Load())
		}
		stopEntry()
		stops[id] = startStage(id)
		stopEntry = passwordTLSRunOwned(t, fmt.Sprintf("restored-entry-%d", i), render.StockSingBoxVersion, binary, grouped["entry"])
		if body, e := request(); e != nil || body != "anytls-via-relay-payload" || hits.Load() != before+1 {
			t.Fatalf("restored %s chain: body=%q error=%v hits=%d", id, body, e, hits.Load())
		}
		anyTLSChainUDP(t, fmt.Sprintf("127.0.0.1:%d", entryPort))
	}
}

// SOCKS UDP ASSOCIATE -> AnyTLS UoT -> UDP echo; either relay carries TCP only.
func anyTLSChainUDP(t *testing.T, entry string) {
	t.Helper()
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		b := make([]byte, 2048)
		n, a, e := echo.ReadFrom(b)
		if e == nil {
			echo.WriteTo(b[:n], a)
		}
	}()
	control, err := net.DialTimeout("tcp", entry, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	control.SetDeadline(time.Now().Add(4 * time.Second))
	exchange := func(request []byte, n int) []byte {
		t.Helper()
		if _, e := control.Write(request); e != nil {
			t.Fatal(e)
		}
		b := make([]byte, n)
		if _, e := io.ReadFull(control, b); e != nil {
			t.Fatal(e)
		}
		return b
	}
	if b := exchange([]byte{5, 1, 2}, 2); b[0] != 5 || b[1] != 2 {
		t.Fatalf("UDP SOCKS negotiation: %v", b)
	}
	auth := append([]byte{1, 7}, []byte("fixture")...)
	auth = append(auth, 10)
	auth = append(auth, []byte("local-only")...)
	if b := exchange(auth, 2); b[1] != 0 {
		t.Fatalf("UDP SOCKS authentication: %v", b)
	}
	reply := exchange([]byte{5, 3, 0, 1, 127, 0, 0, 1, 0, 0}, 4)
	if reply[0] != 5 || reply[1] != 0 {
		t.Fatalf("UDP associate rejected: %v", reply)
	}
	var host string
	switch reply[3] {
	case 1:
		b := make([]byte, 4)
		if _, err = io.ReadFull(control, b); err != nil {
			t.Fatal(err)
		}
		host = net.IP(b).String()
	case 4:
		b := make([]byte, 16)
		if _, err = io.ReadFull(control, b); err != nil {
			t.Fatal(err)
		}
		host = net.IP(b).String()
	default:
		t.Fatalf("unexpected UDP relay address type %d", reply[3])
	}
	p := make([]byte, 2)
	if _, err = io.ReadFull(control, p); err != nil {
		t.Fatal(err)
	}
	if net.ParseIP(host).IsUnspecified() {
		host = "127.0.0.1"
	}
	relay := net.JoinHostPort(host, strconv.Itoa(int(p[0])<<8|int(p[1])))
	c, err := net.DialTimeout("udp", relay, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(4 * time.Second))
	target := echo.LocalAddr().(*net.UDPAddr)
	payload := []byte("anytls-via-relay-udp-payload")
	packet := append([]byte{0, 0, 0, 1, 127, 0, 0, 1, byte(target.Port >> 8), byte(target.Port)}, payload...)
	if _, err = c.Write(packet); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, 2048)
	n, err := c.Read(response)
	if err != nil {
		t.Fatalf("AnyTLS UoT roundtrip: %v", err)
	}
	if n != len(packet) || string(response[:n]) != string(packet) {
		t.Fatalf("UDP payload/address mismatch: %x", response[:n])
	}
}
