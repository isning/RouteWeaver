package httpapi_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

const resolvedClientDomain = "resolved.example.invalid."
const missingClientDomain = "unavailable.example.invalid."

// Exact API-published bytes configure the client's resolver. Unlike the SOCKS
// delegation case, direct routing forces resolution before reaching the origin.
func TestNativeDownloadedClientConfiguredDNS(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			if !strings.Contains(","+os.Getenv("ROUTEWEAVER_CLIENT_PROCESS_TESTS")+",", ","+target.AdapterID+",") {
				t.Skip("explicit client process opt-in required")
			}
			binary := os.Getenv("ROUTEWEAVER_MIHOMO_BIN")
			args := []string{"-v"}
			if target.AdapterID == "sing-box" {
				binary = os.Getenv("ROUTEWEAVER_SINGBOX_BIN")
				args = []string{"version"}
			}
			if binary == "" {
				t.Fatal("requested native executable missing")
			}
			versionCtx, versionCancel := context.WithTimeout(context.Background(), 3*time.Second)
			version, err := exec.CommandContext(versionCtx, binary, args...).CombinedOutput()
			versionCancel()
			if err != nil || !strings.Contains(string(version), target.Version) {
				t.Fatalf("native version mismatch: %v %s", err, version)
			}
			dns := newClientDNSFixture(t)
			var reached atomic.Int64
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reached.Add(1)
				io.WriteString(w, "configured-dns-origin")
			}))
			defer origin.Close()
			originURL, _ := url.Parse(origin.URL)
			feed, port := publishedClientDNSFeed(t, target, dns.conn.LocalAddr().(*net.UDPAddr).Port)
			dir := t.TempDir()
			config := filepath.Join(dir, "downloaded-dns-feed.json")
			if err = os.WriteFile(config, []byte(feed), 0600); err != nil {
				t.Fatal(err)
			}
			log, err := os.Create(filepath.Join(dir, "native.log"))
			if err != nil {
				t.Fatal(err)
			}
			defer log.Close()
			args = []string{"-d", dir, "-f", config}
			marker, hook, err := newClientReadyMarker(dir, target.AdapterID)
			if err != nil {
				t.Fatal(err)
			}
			if hook != "" {
				args = append(args, "-post-up", hook)
			}
			if target.AdapterID == "sing-box" {
				args = []string{"run", "-c", config, "-D", dir}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, binary, args...)
			cmd.Dir = dir
			cmd.Stdout = log
			cmd.Stderr = log
			binaryBytes, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			binarySHA, configSHA := sha256.Sum256(binaryBytes), sha256.Sum256([]byte(feed))
			started := time.Now()
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			var exitErr error // Read only after done closes.
			go func() { exitErr = cmd.Wait(); close(done) }()
			t.Cleanup(func() {
				cancel()
				processStatus := "did not exit"
				select {
				case <-done:
					processStatus = fmt.Sprint(exitErr)
				case <-time.After(3 * time.Second):
					t.Error("native DNS child did not exit")
				}
				if t.Failed() {
					body, readErr := os.ReadFile(log.Name())
					markerBytes, markerErr := os.ReadFile(marker)
					t.Logf("native DNS diagnostics: elapsed=%s pid=%d exit=%s binarySHA256=%x configSHA256=%x origin=%s mixed=127.0.0.1:%d dns=%s marker=%q markerReadError=%v reached=%d positiveQueries=%d negativeQueries=%d nativeLogReadError=%v\nnative.log:\n%s", time.Since(started), cmd.Process.Pid, processStatus, binarySHA, configSHA, origin.URL, port, dns.conn.LocalAddr(), markerBytes, markerErr, reached.Load(), dns.positive.Load(), dns.negative.Load(), readErr, body)
				}
			})
			address := fmt.Sprintf("127.0.0.1:%d", port)
			startup, startupCancel := context.WithTimeout(ctx, 5*time.Second)
			err = waitClientReady(startup, address, marker, done)
			startupCancel()
			if err != nil {
				t.Fatal(err)
			}
			proxy, _ := url.Parse("http://" + address)
			transport := &http.Transport{Proxy: http.ProxyURL(proxy), DisableKeepAlives: true}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
			r, err := client.Get("http://" + net.JoinHostPort(strings.TrimSuffix(resolvedClientDomain, "."), originURL.Port()) + "/")
			if err != nil {
				t.Fatalf("configured DNS positive: %v", err)
			}
			body, err := io.ReadAll(r.Body)
			r.Body.Close()
			if err != nil || r.StatusCode != 200 || string(body) != "configured-dns-origin" || reached.Load() != 1 || dns.positive.Load() == 0 {
				t.Fatalf("configured resolver not proven: status=%d body=%q err=%v reached=%d queries=%d", r.StatusCode, body, err, reached.Load(), dns.positive.Load())
			}
			r, err = client.Get("http://" + net.JoinHostPort(strings.TrimSuffix(missingClientDomain, "."), originURL.Port()) + "/")
			if err == nil {
				body, readErr := io.ReadAll(r.Body)
				r.Body.Close()
				if readErr == nil && r.StatusCode == 200 {
					t.Fatalf("NXDOMAIN unexpectedly succeeded: %q", body)
				}
			}
			if dns.negative.Load() == 0 {
				t.Fatal("failure did not query configured resolver")
			}
			if reached.Load() != 1 {
				t.Fatal("failed resolution reached the origin")
			}
			t.Logf("%s %s: exact published DNS configuration, observed UDP resolution to owned origin and fresh-name NXDOMAIN failure passed", target.AdapterID, target.Version)
		})
	}
}

func publishedClientDNSFeed(t *testing.T, target render.Target, dnsPort int) (string, int) {
	t.Helper()
	s, srv := makeServer(t)
	user := inviteClient(t, s, srv, "dns-client-user")
	p := templateTestProfile("dns-client", target)
	p.IR.Endpoints = nil
	p.IR.DefaultAction = domain.ActionRef{Kind: "direct"}
	p.IR.Runtime.MixedPort = publishedFreePort(t)
	p.IR.Runtime.DNS = &domain.DNSIntent{Servers: []domain.DNSResolver{{ID: "owned-dns", Type: "udp", Address: "127.0.0.1", Port: dnsPort}}, Final: "owned-dns"}
	code, _, raw := req(t, user.c, "POST", srv.URL+"/api/me/profiles", user.csrf, p)
	if code != 200 {
		t.Fatalf("save DNS profile: %d %s", code, raw)
	}
	code, out, raw := req(t, user.c, "POST", srv.URL+"/api/me/outputs", user.csrf, map[string]string{"id": "dns-output", "name": "DNS reference", "profileId": p.ID})
	if code != 201 {
		t.Fatalf("publish DNS profile: %d %s", code, raw)
	}
	code, _, feed := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
	if code != 200 {
		t.Fatalf("download DNS profile: %d", code)
	}
	return feed, p.IR.Runtime.MixedPort
}

// The fixture never forwards queries. Only one reserved name has an IPv4
// answer; unknown names return NXDOMAIN and AAAA queries return an empty answer.
type clientDNSFixture struct {
	conn               *net.UDPConn
	positive, negative atomic.Int64
}

func newClientDNSFixture(t *testing.T) *clientDNSFixture {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	f := &clientDNSFixture{conn: conn}
	done := make(chan struct{})
	t.Cleanup(func() { conn.Close(); <-done })
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, peer, e := conn.ReadFromUDP(buf)
			if e != nil {
				return
			}
			var query dnsmessage.Message
			if query.Unpack(buf[:n]) != nil || len(query.Questions) != 1 || query.Header.Response {
				continue
			}
			question := query.Questions[0]
			name := strings.ToLower(question.Name.String())
			reply := dnsmessage.Message{Header: dnsmessage.Header{ID: query.ID, Response: true, RecursionDesired: query.RecursionDesired, RecursionAvailable: true}, Questions: query.Questions}
			if name == resolvedClientDomain {
				f.positive.Add(1)
				if question.Type == dnsmessage.TypeA && question.Class == dnsmessage.ClassINET {
					reply.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: question.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 0}, Body: &dnsmessage.AResource{A: [4]byte{127, 0, 0, 1}}}}
				}
			} else {
				reply.Header.RCode = dnsmessage.RCodeNameError
				if name == missingClientDomain {
					f.negative.Add(1)
				}
			}
			packet, e := reply.Pack()
			if e == nil {
				conn.WriteToUDP(packet, peer)
			}
		}
	}()
	return f
}

func TestClientDNSFixtureAndPublishedResolver(t *testing.T) {
	dns := newClientDNSFixture(t)
	for _, name := range []string{resolvedClientDomain, missingClientDomain} {
		qname, err := dnsmessage.NewName(name)
		if err != nil {
			t.Fatal(err)
		}
		query := dnsmessage.Message{Header: dnsmessage.Header{ID: 71, RecursionDesired: true}, Questions: []dnsmessage.Question{{Name: qname, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}}}
		packet, err := query.Pack()
		if err != nil {
			t.Fatal(err)
		}
		conn, err := net.DialUDP("udp", nil, dns.conn.LocalAddr().(*net.UDPAddr))
		if err != nil {
			t.Fatal(err)
		}
		conn.SetDeadline(time.Now().Add(time.Second))
		if _, err = conn.Write(packet); err != nil {
			conn.Close()
			t.Fatal(err)
		}
		buf := make([]byte, 4096)
		n, err := conn.Read(buf)
		conn.Close()
		if err != nil {
			t.Fatal(err)
		}
		var reply dnsmessage.Message
		if err = reply.Unpack(buf[:n]); err != nil {
			t.Fatal(err)
		}
		if reply.ID != 71 || !reply.Response {
			t.Fatal("fixture response identity mismatch")
		}
		if name == resolvedClientDomain {
			if len(reply.Answers) != 1 || reply.Answers[0].Body.(*dnsmessage.AResource).A != [4]byte{127, 0, 0, 1} {
				t.Fatal("fixture positive mismatch")
			}
		} else if reply.RCode != dnsmessage.RCodeNameError || len(reply.Answers) != 0 {
			t.Fatal("fixture negative mismatch")
		}
	}
	if dns.positive.Load() != 1 || dns.negative.Load() != 1 {
		t.Fatal("fixture query counters mismatch")
	}
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			feed, _ := publishedClientDNSFeed(t, target, dns.conn.LocalAddr().(*net.UDPAddr).Port)
			var config map[string]any
			if err := json.Unmarshal([]byte(feed), &config); err != nil {
				t.Fatal(err)
			}
			dnsConfig := config["dns"].(map[string]any)
			port := dns.conn.LocalAddr().(*net.UDPAddr).Port
			if target.AdapterID == "mihomo" {
				names := dnsConfig["nameserver"].([]any)
				if len(names) != 1 || names[0] != fmt.Sprintf("udp://127.0.0.1:%d", port) || dnsConfig["enable"] != true {
					t.Fatal("published Mihomo DNS endpoint differs from configured intent")
				}
			} else {
				servers := dnsConfig["servers"].([]any)
				if len(servers) != 1 {
					t.Fatal("unexpected published resolver count")
				}
				server := servers[0].(map[string]any)
				if server["type"] != "udp" || server["server"] != "127.0.0.1" || server["server_port"] != float64(port) || server["tag"] != "owned-dns" || dnsConfig["final"] != "owned-dns" || config["route"].(map[string]any)["default_domain_resolver"] != "owned-dns" {
					t.Fatal("published sing-box DNS endpoint or selection differs from configured intent")
				}
			}
		})
	}
}
