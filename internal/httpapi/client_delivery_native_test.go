package httpapi_test

import (
	"context"
	"crypto/sha256"
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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

// This is opt-in process evidence, not a parser test. The exact downloaded feed
// is the process configuration; no post-publication adapter fields are patched.
// Domain names are delegated to a controlled SOCKS peer, not resolved by public
// DNS. TUN/device integration and a user's ISP network are outside this test.
func TestNativeInvitedUserDownloadedClientTraffic(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			if !strings.Contains(","+os.Getenv("ROUTEWEAVER_CLIENT_PROCESS_TESTS")+",", ","+target.AdapterID+",") {
				t.Skip("explicit client process opt-in required")
			}
			env := "ROUTEWEAVER_MIHOMO_BIN"
			versionArgs := []string{"-v"}
			if target.AdapterID == "sing-box" {
				env = "ROUTEWEAVER_SINGBOX_BIN"
				versionArgs = []string{"version"}
			}
			binary := os.Getenv(env)
			if binary == "" {
				t.Fatal("requested native executable missing: " + env)
			}
			versionCtx, versionCancel := context.WithTimeout(context.Background(), 3*time.Second)
			version, err := exec.CommandContext(versionCtx, binary, versionArgs...).CombinedOutput()
			versionCancel()
			if err != nil || !strings.Contains(string(version), target.Version) {
				t.Fatalf("native version mismatch: %v %s", err, version)
			}
			var originRequests atomic.Int64
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				originRequests.Add(1)
				io.WriteString(w, "client-feed-loopback-proof")
			}))
			defer origin.Close()
			originURL, _ := url.Parse(origin.URL)
			relay := newDeliverySOCKS(t, originURL.Host)
			s, srv := makeServer(t)
			user := inviteClient(t, s, srv, "delivery-user")
			other := inviteClient(t, s, srv, "other-user")
			p := templateTestProfile("delivery", target)
			p.IR.Runtime.MixedPort = publishedFreePort(t)
			p.IR.Endpoints[0].Connection = domain.Connection{Protocol: "socks", Host: "127.0.0.1", Port: relay.listener.Addr().(*net.TCPAddr).Port}
			p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "node"}
			p.IR.Rules = []domain.PolicyRule{{ID: "reject", Match: domain.MatchExpression{Op: "domain", Value: "blocked.example.invalid"}, Action: domain.ActionRef{Kind: "reject"}}}
			code, _, raw := req(t, user.c, "POST", srv.URL+"/api/me/profiles", user.csrf, p)
			if code != 200 {
				t.Fatalf("save profile: %d %s", code, raw)
			}
			code, out, raw := req(t, user.c, "POST", srv.URL+"/api/me/outputs", user.csrf, map[string]string{"id": "delivery", "name": "Private client feed", "profileId": p.ID})
			if code != 201 {
				t.Fatalf("publish: %d %s", code, raw)
			}
			first := out["feedPath"].(string)
			code, _, feed := req(t, http.DefaultClient, "GET", srv.URL+first, "", nil)
			if code != 200 {
				t.Fatalf("download: %d", code)
			}
			if code, _, _ = req(t, other.c, "GET", srv.URL+"/api/me/outputs/delivery/access", "", nil); code != 404 {
				t.Fatalf("other account feed access: %d", code)
			}
			dir := t.TempDir()
			config := filepath.Join(dir, "downloaded-feed.json")
			if err = os.WriteFile(config, []byte(feed), 0600); err != nil {
				t.Fatal(err)
			}
			binaryBytes, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			binarySHA, configSHA := sha256.Sum256(binaryBytes), sha256.Sum256([]byte(feed))
			logFile, err := os.Create(filepath.Join(dir, "native.log"))
			if err != nil {
				t.Fatal(err)
			}
			defer logFile.Close()
			args := []string{"-d", dir, "-f", config}
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
			cmd.Stdout = logFile
			cmd.Stderr = logFile
			started := time.Now()
			phase := "startup"
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
					t.Error("native child did not exit")
				}
				if t.Failed() {
					log, readErr := os.ReadFile(logFile.Name())
					markerBytes, markerErr := os.ReadFile(marker)
					t.Logf("native delivery diagnostics: phase=%s elapsed=%s pid=%d exit=%s binarySHA256=%x configSHA256=%x origin=%s mixed=127.0.0.1:%d relay=%s marker=%q markerReadError=%v originRequests=%d connections=%d requests=%d accepted=%d domains=%d trace=%v nativeLogReadError=%v\nnative.log:\n%s", phase, time.Since(started), cmd.Process.Pid, processStatus, binarySHA, configSHA, origin.URL, p.IR.Runtime.MixedPort, relay.listener.Addr(), markerBytes, markerErr, originRequests.Load(), relay.connections.Load(), relay.requests.Load(), relay.accepted.Load(), relay.domains.Load(), relay.diagnostics(), readErr, log)
				}
			})
			address := fmt.Sprintf("127.0.0.1:%d", p.IR.Runtime.MixedPort)
			startup, startupCancel := context.WithTimeout(ctx, 5*time.Second)
			err = waitClientReady(startup, address, marker, done)
			startupCancel()
			if err != nil {
				t.Fatal(err)
			}
			proxy, _ := url.Parse("http://" + address)
			transport := &http.Transport{Proxy: http.ProxyURL(proxy), DisableKeepAlives: true}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
			fetch := func(label, destination string, want bool) {
				t.Helper()
				phase = label
				r, e := client.Get(destination)
				if e != nil {
					if want {
						t.Fatal(e)
					}
					return
				}
				defer r.Body.Close()
				body, e := io.ReadAll(r.Body)
				success := e == nil && r.StatusCode == 200 && string(body) == "client-feed-loopback-proof"
				if success != want {
					t.Fatalf("unexpected traffic result status=%d body=%q err=%v", r.StatusCode, body, e)
				}
			}
			fetch("initial-ip", origin.URL, true)
			fetch("delegated-domain", "http://route.example.invalid:"+originURL.Port()+"/", true)
			if relay.domains.Load() != 1 {
				t.Fatal("domain destination was not delegated to the required peer")
			}
			// Earlier fetches have completed their SOCKS handshakes and HTTP
			// responses, so both counters already include those requests. Count
			// attempts before allowlisting: a refused peer request is still a
			// routing failure, not evidence that the client applied its rule.
			beforeConnections, beforeRequests := relay.connections.Load(), relay.requests.Load()
			if beforeConnections != 2 || beforeRequests != 2 || relay.accepted.Load() != 2 {
				t.Fatal("positive IP/domain requests did not each use exactly one required peer connection")
			}
			fetch("reject-rule", "http://blocked.example.invalid:"+originURL.Port()+"/", false)
			if relay.connections.Load() != beforeConnections || relay.requests.Load() != beforeRequests {
				t.Fatal("rejected rule reached upstream peer")
			}
			// Rotation revokes the download capability, not already downloaded credentials.
			code, out, raw = req(t, user.c, "POST", srv.URL+"/api/me/outputs/delivery/rotate", user.csrf, map[string]any{})
			if code != 200 {
				t.Fatalf("rotate: %d %s", code, raw)
			}
			second := out["feedPath"].(string)
			if code, _, _ = req(t, http.DefaultClient, "GET", srv.URL+first, "", nil); code != 404 {
				t.Fatal("old feed remains readable")
			}
			code, _, rotated := req(t, http.DefaultClient, "GET", srv.URL+second, "", nil)
			if code != 200 || rotated != feed {
				t.Fatal("rotation changed frozen configuration")
			}
			fetch("after-rotation", origin.URL, true)
			relay.close()
			fetch("closed-peer", origin.URL, false) // The direct origin is still reachable; fallback is forbidden.
			direct, err := http.Get(origin.URL)
			if err != nil {
				t.Fatal(err)
			}
			direct.Body.Close()
			if code, _, _ = req(t, user.c, "POST", srv.URL+"/api/me/outputs/delivery/revoke", user.csrf, map[string]any{}); code != 200 {
				t.Fatal("feed revoke failed")
			}
			if code, _, _ = req(t, http.DefaultClient, "GET", srv.URL+second, "", nil); code != 404 {
				t.Fatal("revoked feed remains readable")
			}
			t.Logf("%s %s: invitation, frozen download, actual client traffic, delegated domain, reject rule, rotation, peer failure without direct fallback and feed revocation", target.AdapterID, target.Version)
		})
	}
}

// A deliberately narrow SOCKS5 peer. It only connects to the test-owned HTTP
// origin and rejects all destinations except its exact IP or reserved test name.
type deliverySOCKS struct {
	listener              net.Listener
	accepted, domains     atomic.Int64
	connections, requests atomic.Int64
	stop                  sync.Once
	workers               sync.WaitGroup
	done                  chan struct{}
	traceMu               sync.Mutex
	trace                 []string
}

func (s *deliverySOCKS) record(event string) {
	s.traceMu.Lock()
	defer s.traceMu.Unlock()
	if len(s.trace) < 32 {
		s.trace = append(s.trace, event)
	}
}

func (s *deliverySOCKS) diagnostics() []string {
	s.traceMu.Lock()
	defer s.traceMu.Unlock()
	return append([]string(nil), s.trace...)
}

func (s *deliverySOCKS) close() { s.stop.Do(func() { s.listener.Close(); <-s.done; s.workers.Wait() }) }
func newDeliverySOCKS(t *testing.T, origin string) *deliverySOCKS {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &deliverySOCKS{listener: ln, done: make(chan struct{})}
	t.Cleanup(s.close)
	host, port, _ := net.SplitHostPort(origin)
	go func() {
		defer close(s.done)
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			s.connections.Add(1)
			s.record("connected " + c.RemoteAddr().String())
			s.workers.Add(1)
			go func() {
				defer s.workers.Done()
				defer c.Close()
				c.SetDeadline(time.Now().Add(3 * time.Second))
				h := make([]byte, 2)
				if _, e := io.ReadFull(c, h); e != nil || h[0] != 5 {
					s.record(fmt.Sprintf("greeting rejected version=%d error=%v", h[0], e))
					return
				}
				methods := make([]byte, int(h[1]))
				if _, e := io.ReadFull(c, methods); e != nil {
					s.record("methods read failed: " + e.Error())
					return
				}
				if _, e := c.Write([]byte{5, 0}); e != nil {
					s.record("method reply failed: " + e.Error())
					return
				}
				head := make([]byte, 4)
				if _, e := io.ReadFull(c, head); e != nil || head[0] != 5 || head[1] != 1 {
					s.record(fmt.Sprintf("connect header rejected version=%d command=%d error=%v", head[0], head[1], e))
					return
				}
				var requested string
				switch head[3] {
				case 1:
					ip := make([]byte, 4)
					if _, e := io.ReadFull(c, ip); e != nil {
						return
					}
					requested = net.IP(ip).String()
				case 3:
					n := make([]byte, 1)
					if _, e := io.ReadFull(c, n); e != nil {
						return
					}
					name := make([]byte, int(n[0]))
					if _, e := io.ReadFull(c, name); e != nil {
						return
					}
					requested = string(name)
				default:
					s.record(fmt.Sprintf("address type rejected: %d", head[3]))
					return
				}
				pb := make([]byte, 2)
				if _, e := io.ReadFull(c, pb); e != nil {
					return
				}
				requestedPort := fmt.Sprint(int(pb[0])<<8 | int(pb[1]))
				s.requests.Add(1)
				s.record("requested " + net.JoinHostPort(requested, requestedPort))
				if (requested != host && requested != "route.example.invalid") || requestedPort != port {
					s.record("destination rejected")
					return
				}
				s.accepted.Add(1)
				if requested == "route.example.invalid" {
					s.domains.Add(1)
				}
				up, e := net.DialTimeout("tcp", origin, time.Second)
				if e != nil {
					s.record("origin dial failed: " + e.Error())
					return
				}
				defer up.Close()
				up.SetDeadline(time.Now().Add(3 * time.Second))
				if _, e = c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0}); e != nil {
					s.record("connect reply failed: " + e.Error())
					return
				}
				s.record("forwarding")
				copied := make(chan struct{})
				go func() { io.Copy(up, c); up.(*net.TCPConn).CloseWrite(); close(copied) }()
				io.Copy(c, up)
				c.Close()
				<-copied
			}()
		}
	}()
	return s
}

// Validate the fixture itself through its public wire protocol without starting
// either native binary. This is not a substitute for the opt-in native cases.
func TestClientDeliverySOCKSFixtureIsDestinationBounded(t *testing.T) {
	var originRequests atomic.Int64
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		originRequests.Add(1)
		io.WriteString(w, "owned-origin")
	}))
	defer origin.Close()
	u, _ := url.Parse(origin.URL)
	relay := newDeliverySOCKS(t, u.Host)
	proxy, _ := url.Parse("socks5://" + relay.listener.Addr().String())
	tr := &http.Transport{Proxy: http.ProxyURL(proxy), DisableKeepAlives: true}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: time.Second}
	for _, host := range []string{"127.0.0.1", "route.example.invalid"} {
		r, e := client.Get("http://" + net.JoinHostPort(host, u.Port()))
		if e != nil {
			t.Fatal(e)
		}
		body, e := io.ReadAll(r.Body)
		r.Body.Close()
		if e != nil || string(body) != "owned-origin" {
			t.Fatalf("fixture traffic %q %v", body, e)
		}
	}
	if relay.accepted.Load() != 2 || relay.domains.Load() != 1 {
		t.Fatal("fixture did not record expected traffic")
	}
	for i, address := range []string{"http://blocked.example.invalid:" + u.Port(), "http://192.0.2.1:" + u.Port(), "http://127.0.0.1:1"} {
		r, e := client.Get(address)
		if e == nil {
			r.Body.Close()
			t.Fatal("fixture accepted foreign destination")
		}
		// In particular, forwarding the blocked name must be observable even
		// though the bounded peer refuses it. This catches the old false proof
		// based only on the count of allowlisted/forwarded requests.
		if relay.connections.Load() != int64(3+i) || relay.requests.Load() != int64(3+i) {
			t.Fatal("refused upstream attempt was not recorded")
		}
		if originRequests.Load() != 2 {
			t.Fatal("refused upstream attempt contacted the owned origin")
		}
	}
	if relay.accepted.Load() != 2 {
		t.Fatal("foreign request counted as authorized")
	}
	relay.close()
	if r, e := client.Get(origin.URL); e == nil {
		r.Body.Close()
		t.Fatal("closed fixture still available")
	}
}
