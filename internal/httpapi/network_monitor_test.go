package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/notifications"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

func monitorFixture(t *testing.T) (*store.Store, http.Handler, string) {
	t.Helper()
	s := subscriptionTestStore(t)
	host := domain.Host{ID: "monitor-host", Name: "Test node", Address: "8.8.8.8"}
	if err := s.Put("hosts", host.ID, host); err != nil {
		t.Fatal(err)
	}
	return s, NewWithOptions(s, render.Default(), Options{AdminToken: subscriptionTestAdmin}), "/api/admin/hosts/monitor-host/network-monitor"
}
func monitorSettings(revision any, enabled bool) map[string]any {
	return map[string]any{"expectedRevision": revision, "enabled": enabled, "notify": true, "intervalMinutes": 5, "protocol": "tcp", "port": 443}
}
func readMonitorForTest(t *testing.T, s *store.Store) networkMonitor {
	t.Helper()
	var m networkMonitor
	if err := s.Get(networkMonitorKind, "monitor-host", &m); err != nil {
		t.Fatal(err)
	}
	return m
}
func TestNetworkMonitorAuthorizationSettingsAndQueue(t *testing.T) {
	_, h, path := monitorFixture(t)
	if code, _ := subscriptionRequest(t, h, "GET", path, nil, false); code != 401 {
		t.Fatalf("anonymous %d", code)
	}
	code, state := subscriptionRequest(t, h, "GET", path, nil, true)
	if code != 200 || state["enabled"] != false || state["revision"] != float64(0) {
		t.Fatalf("default %d %#v", code, state)
	}
	if code, _ := subscriptionRequest(t, h, "POST", path+"/check", map[string]any{"expectedRevision": 0}, true); code != 409 {
		t.Fatalf("unsaved check %d", code)
	}
	settings := monitorSettings(0, false)
	settings["intervalMinutes"] = 1
	settings["probeCities"] = map[string]string{"telecom": "Beijing"}
	code, state = subscriptionRequest(t, h, "PUT", path, settings, true)
	if code != 200 || state["target"] != "8.8.8.8" || state["intervalMinutes"] != float64(1) || state["probeCities"].(map[string]any)["telecom"] != "Beijing" {
		t.Fatalf("save %d %#v", code, state)
	}
	if code, _ := subscriptionRequest(t, h, "PUT", path, monitorSettings(0, true), true); code != 409 {
		t.Fatalf("stale save %d", code)
	}
	if code, _ := subscriptionRequest(t, h, "POST", path+"/check", map[string]any{"expectedRevision": state["revision"]}, true); code != 202 {
		t.Fatalf("queue %d", code)
	}
	if code, _ := subscriptionRequest(t, h, "PUT", path, monitorSettings(2, false), true); code != 409 {
		t.Fatalf("pending edit %d", code)
	}
	if code, _ := subscriptionRequest(t, h, "POST", path+"/check", map[string]any{"expectedRevision": 2}, true); code != 409 {
		t.Fatalf("duplicate %d", code)
	}
}
func TestNetworkMonitorUsesIndependentIPAfterHostAddressChanges(t *testing.T) {
	s, h, path := monitorFixture(t)
	host := domain.Host{ID: "monitor-host", Name: "Test", Address: "127.0.0.1"}
	if err := s.Put("hosts", host.ID, host); err != nil {
		t.Fatal(err)
	}
	in := monitorSettings(0, false)
	in["monitorIp"] = "10.0.0.1"
	if code, _ := subscriptionRequest(t, h, "PUT", path, in, true); code != 400 {
		t.Fatalf("private override: %d", code)
	}
	in["monitorIp"] = "2606:4700:4700::1111"
	code, state := subscriptionRequest(t, h, "PUT", path, in, true)
	if code != 200 || state["target"] != in["monitorIp"] || state["monitorIp"] != in["monitorIp"] {
		t.Fatalf("independent IP was not saved: %d %#v", code, state)
	}
	host.Address = "9.9.9.9"
	if err := s.Put("hosts", host.ID, host); err != nil {
		t.Fatal(err)
	}
	code, state = subscriptionRequest(t, h, "GET", path, nil, true)
	if code != 200 || state["requiresReview"] != false || state["currentTarget"] != in["monitorIp"] {
		t.Fatalf("host edit changed the independent IP: %d %#v", code, state)
	}
	if code, _ := subscriptionRequest(t, h, "POST", path+"/check", map[string]any{"expectedRevision": state["revision"]}, true); code != 202 {
		t.Fatalf("independent IP could not be queued after host address changed: %d", code)
	}
}

func TestNetworkMonitorBoundedSettingsAndPrivateTarget(t *testing.T) {
	s, h, path := monitorFixture(t)
	for _, port := range []int{0, 65536} {
		in := monitorSettings(0, false)
		in["port"] = port
		if code, _ := subscriptionRequest(t, h, "PUT", path, in, true); code != 400 {
			t.Fatalf("port %d", code)
		}
	}
	for _, target := range []string{"127.0.0.1", "10.0.0.1", "::ffff:127.0.0.1", "metadata", "https://example.com", "example.com:443"} {
		s.Put("hosts", "monitor-host", domain.Host{ID: "monitor-host", Name: "Test", Address: target})
		if code, _ := subscriptionRequest(t, h, "PUT", path, monitorSettings(0, true), true); code != 400 {
			t.Fatalf("accepted target %s: %d", target, code)
		}
	}
}
func fakeGlobalping(t *testing.T, now *time.Time, up *bool, calls *atomic.Int32) *globalpingClient {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/probes" {
			json.NewEncoder(w).Encode([]any{map[string]any{"location": globalpingLocation{Country: "CN", ASN: 4134, City: "Shanghai"}}, map[string]any{"location": globalpingLocation{Country: "CN", ASN: 4837}}, map[string]any{"location": globalpingLocation{Country: "CN", ASN: 9808}}})
			return
		}
		if r.Method == "POST" {
			calls.Add(1)
			var in struct {
				Target    string `json:"target"`
				Locations []struct {
					Country string `json:"country"`
					ASN     int    `json:"asn"`
					Limit   int    `json:"limit"`
				} `json:"locations"`
				Options struct {
					Protocol string `json:"protocol"`
					Port     int    `json:"port"`
					Packets  int    `json:"packets"`
				} `json:"measurementOptions"`
			}
			json.NewDecoder(r.Body).Decode(&in)
			if in.Target != "8.8.8.8" || len(in.Locations) != 1 || in.Locations[0].Country != "CN" || in.Locations[0].Limit != 1 || in.Options.Protocol != "TCP" || in.Options.Port != 443 || in.Options.Packets != 3 {
				t.Errorf("bad provider request %#v", in)
			}
			w.WriteHeader(202)
			json.NewEncoder(w).Encode(map[string]any{"id": strconv.Itoa(in.Locations[0].ASN)})
			return
		}
		asn, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/measurements/"))
		received := 0
		var avg any = nil
		loss := 100
		if *up {
			received = 3
			avg = 42.5
			loss = 0
		}
		json.NewEncoder(w).Encode(map[string]any{"id": strconv.Itoa(asn), "status": "finished", "target": "8.8.8.8", "results": []any{map[string]any{"probe": globalpingLocation{Country: "CN", ASN: asn, City: "Shanghai", Network: "Test carrier"}, "result": map[string]any{"status": "finished", "stats": map[string]any{"avg": avg, "rcv": received, "total": 3, "loss": loss}}}}})
	}))
	t.Cleanup(server.Close)
	return &globalpingClient{client: server.Client(), base: server.URL, now: func() time.Time { return *now }}
}
func TestNetworkMonitorSchedulesPersistsAndDeduplicatesIncidents(t *testing.T) {
	s, h, path := monitorFixture(t)
	code, _ := subscriptionRequest(t, h, "PUT", path, monitorSettings(0, true), true)
	if code != 200 {
		t.Fatal(code)
	}
	now := time.Now().Add(time.Second)
	up := false
	var calls atomic.Int32
	g := fakeGlobalping(t, &now, &up, &calls)
	for i := 0; i < 4; i++ {
		if err := runNetworkMonitorBatch(context.Background(), s, g, now); err != nil {
			t.Fatal(err)
		}
		now = now.Add(6 * time.Minute)
	}
	m := readMonitorForTest(t, s)
	if len(m.History) != 4 || !m.Incidents["telecom"] || calls.Load() != 12 {
		t.Fatalf("history/incident/calls %#v %d", m, calls.Load())
	}
	inbox, err := notifications.New(s, nil).Inbox(notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}, now)
	if err != nil || len(inbox) != 3 {
		t.Fatalf("incident notices %d %v", len(inbox), err)
	}
	up = true
	if err := runNetworkMonitorBatch(context.Background(), s, g, now); err != nil {
		t.Fatal(err)
	}
	m = readMonitorForTest(t, s)
	if m.Incidents["telecom"] || m.History[4].Results[0].LatencyMS == nil || *m.History[4].Results[0].LatencyMS != 42.5 {
		t.Fatalf("recovery %#v", m)
	}
	inbox, err = notifications.New(s, nil).Inbox(notifications.Recipient{ID: "operator", Role: "admin", Enabled: true}, now)
	if err != nil || len(inbox) != 6 {
		t.Fatalf("recovery notices %d %v", len(inbox), err)
	}
	ordinary, err := notifications.New(s, nil).Inbox(notifications.Recipient{ID: "member", Role: "user", Enabled: true}, now)
	if err != nil || len(ordinary) != 0 {
		t.Fatalf("private admin notices exposed: %v", err)
	}
	if err := runNetworkMonitorBatch(context.Background(), s, g, now); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 15 {
		t.Fatalf("early reschedule %d", calls.Load())
	}
}
func TestNetworkMonitorMissingCarrierAndQuotaAreUnknown(t *testing.T) {
	s, h, path := monitorFixture(t)
	subscriptionRequest(t, h, "PUT", path, monitorSettings(0, true), true)
	now := time.Now().Add(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/probes" {
			w.Write([]byte(`[]`))
			return
		}
		t.Error("measurement issued without carrier probes")
	}))
	defer server.Close()
	g := &globalpingClient{client: server.Client(), base: server.URL, now: func() time.Time { return now }}
	if err := runNetworkMonitorBatch(context.Background(), s, g, now); err != nil {
		t.Fatal(err)
	}
	m := readMonitorForTest(t, s)
	for _, o := range m.History[0].Results {
		if o.Status != "unknown" || o.Code != "no-probe" {
			t.Fatalf("missing probe %#v", o)
		}
	}
	for i := 0; i < 79; i++ {
		if _, err := reserveNetworkBudget(s, now); err != nil {
			t.Fatal(err)
		}
	}
	until, err := reserveNetworkBudget(s, now)
	if err != nil || !until.After(now) {
		t.Fatalf("budget %v %v", until, err)
	}
}
func TestNetworkMonitorDisabledScheduleAndTargetChangeDoNotSend(t *testing.T) {
	s, h, path := monitorFixture(t)
	subscriptionRequest(t, h, "PUT", path, monitorSettings(0, false), true)
	now := time.Now().Add(time.Second)
	up := true
	var calls atomic.Int32
	g := fakeGlobalping(t, &now, &up, &calls)
	if err := runNetworkMonitorBatch(context.Background(), s, g, now); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 {
		t.Fatal("disabled monitor sent traffic")
	}
	subscriptionRequest(t, h, "PUT", path, monitorSettings(1, true), true)
	s.Put("hosts", "monitor-host", domain.Host{ID: "monitor-host", Name: "Changed", Address: "1.1.1.1"})
	if err := runNetworkMonitorBatch(context.Background(), s, g, now); err != nil {
		t.Fatal(err)
	}
	m := readMonitorForTest(t, s)
	if calls.Load() != 0 || m.ErrorCode != "target-changed" || m.Enabled {
		t.Fatalf("target change %#v", m)
	}
}

func TestNetworkMonitorProviderRateLimitPersistsAndDoesNotReportOutage(t *testing.T) {
	s, h, path := monitorFixture(t)
	subscriptionRequest(t, h, "PUT", path, monitorSettings(0, true), true)
	now := time.Now().Add(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Header().Set("Retry-After", "120"); w.WriteHeader(429) }))
	defer server.Close()
	g := &globalpingClient{client: server.Client(), base: server.URL, now: func() time.Time { return now }}
	if err := runNetworkMonitorBatch(context.Background(), s, g, now); err != nil {
		t.Fatal(err)
	}
	m := readMonitorForTest(t, s)
	if m.ErrorCode != "rate-limited" || m.NextCheckAt == nil || !m.NextCheckAt.Equal(now.Add(120*time.Second)) {
		t.Fatalf("backoff %#v", m)
	}
	for _, o := range m.History[0].Results {
		if o.Status != "unknown" || o.Code != "rate-limited" {
			t.Fatalf("rate limit looked like an outage %#v", o)
		}
	}
	until, err := reserveNetworkBudget(s, now.Add(time.Second))
	if err != nil || !until.Equal(now.Add(120*time.Second)) {
		t.Fatalf("durable provider backoff %v %v", until, err)
	}
}
func TestNetworkMonitorClassifiesProviderResultsWithoutTrustingIncompleteData(t *testing.T) {
	for _, scenario := range []string{"foreign-asn", "wrong-city", "partial-statistics", "failed-measurement", "target-failure"} {
		t.Run(scenario, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == "POST" {
					if scenario == "wrong-city" {
						var input struct{ Locations []struct{ City string } }
						if err := json.NewDecoder(r.Body).Decode(&input); err != nil || len(input.Locations) != 1 || input.Locations[0].City != "Beijing" {
							t.Error("requested city missing from probe location")
						}
					}
					w.WriteHeader(202)
					w.Write([]byte(`{"id":"test"}`))
					return
				}
				asn := 4134
				result := map[string]any{"status": "finished", "stats": map[string]any{"avg": 10, "rcv": 3, "total": 3, "loss": 0}}
				switch scenario {
				case "foreign-asn":
					asn = 4837
				case "partial-statistics":
					result = map[string]any{"status": "finished"}
				case "failed-measurement":
					result = map[string]any{"status": "failed"}
				case "target-failure":
					result = map[string]any{"status": "failed", "failureSource": "target"}
				}
				json.NewEncoder(w).Encode(map[string]any{"id": "test", "status": "finished", "target": "8.8.8.8", "results": []any{map[string]any{"probe": globalpingLocation{Country: "CN", ASN: asn, City: "Shanghai"}, "result": result}}})
			}))
			defer server.Close()
			now := time.Now()
			g := &globalpingClient{client: server.Client(), base: server.URL, now: func() time.Time { return now }}
			m := networkMonitor{Target: "8.8.8.8", Protocol: "tcp", Port: 443}
			if scenario == "wrong-city" {
				m.ProbeCities = map[string]string{"telecom": "Beijing"}
			}
			result := g.measure(context.Background(), m, "telecom", 4134)
			if scenario == "wrong-city" && result.Code != "probe-mismatch" {
				t.Fatalf("wrong location was not rejected: %+v", result)
			}
			expected := "unknown"
			if scenario == "target-failure" {
				expected = "down"
			}
			if result.Status != expected || result.LatencyMS != nil {
				t.Fatalf("untrusted result marked healthy %#v", result)
			}
		})
	}
}
func TestNetworkMonitorUnknownBreaksFailureStreak(t *testing.T) {
	m := networkMonitor{Notify: true}
	host := domain.Host{ID: "host", Name: "Host"}
	at := time.Now()
	for _, status := range []string{"down", "down", "unknown", "down", "up"} {
		updateNetworkIncidents(&m, host, networkRound{At: at, Results: []networkObservation{{Carrier: "telecom", Status: status}}})
	}
	if len(m.PendingAlerts) > 0 || m.Incidents["telecom"] {
		t.Fatal("unknown observation created a false incident")
	}
}

func TestNetworkMonitorIsAdministratorOnly(t *testing.T) {
	s, h, path := monitorFixture(t)
	_, invite, err := s.CreateInvite("Member", "user", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	account, err := s.AcceptInvite(invite, "monitor-member", "synthetic-member-password")
	if err != nil {
		t.Fatal(err)
	}
	session, token, err := s.NewSession(account, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "PUT", "POST"} {
		target := path
		if method == "POST" {
			target += "/check"
		}
		r := httptest.NewRequest(method, target, strings.NewReader(`{"expectedRevision":0}`))
		r.AddCookie(&http.Cookie{Name: "routeweaver_session", Value: token})
		r.Header.Set("X-CSRF-Token", session.CSRFToken)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("member %s: %d", method, w.Code)
		}
	}
}
func TestNetworkMonitorHistoryRetention(t *testing.T) {
	s, h, path := monitorFixture(t)
	subscriptionRequest(t, h, "PUT", path, monitorSettings(0, true), true)
	m := readMonitorForTest(t, s)
	now := time.Now().Add(time.Second)
	for i := 0; i < networkHistoryLimit; i++ {
		m.History = append(m.History, networkRound{At: now.Add(time.Duration(i-networkHistoryLimit) * 5 * time.Minute), Target: m.Target, Protocol: "tcp", Port: 443, Results: unknownNetworkResults("no-probe")})
	}
	first := m.History[0].At
	if err := s.Put(networkMonitorKind, m.HostID, m); err != nil {
		t.Fatal(err)
	}
	up := true
	var calls atomic.Int32
	g := fakeGlobalping(t, &now, &up, &calls)
	if err := runNetworkMonitorBatch(context.Background(), s, g, now); err != nil {
		t.Fatal(err)
	}
	m = readMonitorForTest(t, s)
	if len(m.History) != networkHistoryLimit || !m.History[0].At.After(first) || !m.History[len(m.History)-1].At.Equal(now) {
		t.Fatal("history did not retain the latest bounded observations")
	}
}
func TestNetworkMonitorPollsConditionallyWithoutReplayingMeasurement(t *testing.T) {
	posts, gets := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" {
			posts++
			w.WriteHeader(202)
			w.Write([]byte(`{"id":"etag"}`))
			return
		}
		gets++
		if gets == 1 {
			w.Header().Set("ETag", `"one"`)
			w.Write([]byte(`{"id":"etag","target":"8.8.8.8","status":"in-progress"}`))
			return
		}
		if r.Header.Get("If-None-Match") != `"one"` {
			t.Error("missing conditional poll")
		}
		if gets == 2 {
			w.WriteHeader(304)
			return
		}
		w.Write([]byte(`{"id":"etag","target":"8.8.8.8","status":"finished","results":[{"probe":{"country":"CN","asn":4134},"result":{"status":"finished","stats":{"total":3,"rcv":3,"loss":0,"avg":20}}}]}`))
	}))
	defer server.Close()
	g := &globalpingClient{client: server.Client(), base: server.URL, now: time.Now}
	o := g.measure(context.Background(), networkMonitor{Target: "8.8.8.8", Protocol: "tcp", Port: 443}, "telecom", 4134)
	if o.Status != "up" || posts != 1 || gets != 3 {
		t.Fatalf("conditional measurement %#v %d/%d", o, posts, gets)
	}
}

func TestNetworkMonitorLoadsProbeDirectoryBeyondMeasurementLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/probes" {
			t.Errorf("unexpected path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`[{"location":{"country":"CN","asn":4134},"metadata":"` +
			strings.Repeat("x", 3<<20) + `"}]`))
	}))
	defer server.Close()
	client := newGlobalpingClient()
	client.base = server.URL
	probes, err := client.available(context.Background())
	if err != nil || selectNetworkASN(probes, []int{4134}, "") != 4134 {
		t.Fatalf("large probe directory could not be used: %v", err)
	}
}

func TestNetworkMonitorPinsAProbeAcrossRounds(t *testing.T) {
	var creates atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			var request struct{ Locations []map[string]any }
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil || len(request.Locations) != 1 {
				t.Error("expected one location")
				http.Error(w, "bad request", 400)
				return
			}
			location := request.Locations[0]
			n := creates.Add(1)
			if n == 1 && (location["city"] != "Beijing" || location["asn"] != float64(4134)) {
				t.Error("initial check did not constrain city and network")
			}
			if n == 2 && (location["magic"] != "measurement-1" || location["city"] != nil) {
				t.Error("subsequent check did not exclusively reuse the pinned probe")
			}
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "measurement-" + strconv.Itoa(int(n))})
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/measurements/")
		results := []any{}
		if id == "measurement-1" {
			results = append(results, map[string]any{
				"probe":  globalpingLocation{Country: "CN", City: "Beijing", ASN: 4134},
				"result": map[string]any{"status": "finished", "stats": map[string]any{"avg": 21, "rcv": 3, "total": 3, "loss": 0}},
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "target": "8.8.8.8", "status": "finished", "results": results})
	}))
	defer server.Close()
	g := &globalpingClient{base: server.URL, client: server.Client(), now: time.Now}
	probe := networkProbeSelection{ID: "custom", Country: "CN", City: "Beijing", ASN: 4134}
	m := networkMonitor{Target: "8.8.8.8", Protocol: "tcp", Port: 443}
	first := g.measureProbe(context.Background(), m, probe, "")
	if first.Status != "up" || first.MeasurementID != "measurement-1" {
		t.Fatalf("first sample did not establish a pin: %+v", first)
	}
	next := g.measureProbe(context.Background(), m, probe, first.MeasurementID)
	if next.Status != "unknown" || next.Code != "pinned-probe-unavailable" || creates.Load() != 2 {
		t.Fatalf("missing pinned probe was retried at another location: %+v", next)
	}
}
