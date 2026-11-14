package httpapi_test

import (
	"net/http"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestMyInsightsAuthenticationIsolationAndPolicy(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "insights-a")
	b := inviteClient(t, s, srv, "insights-b")
	now := time.Now().UTC()
	ent := service.Entitlement{UserID: a.id, StartsAt: now.Add(-time.Hour), Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
	ipLimit, connectionLimit, rate := 2, 3, int64(1024)
	ent.OnlineIPLimitOverride = &ipLimit
	ent.ConnectionLimitOverride = &connectionLimit
	ent.EntryRateBPSOverride = &rate
	if e := s.Put("entitlements", a.id, ent); e != nil {
		t.Fatal(e)
	}

	for _, x := range []struct {
		id, user, route string
		bytes           int64
	}{{"insight-a", a.id, "history-route", 123}, {"insight-b", b.id, "secret-b-route", 456}} {
		e := s.Put("ledger", x.id, store.MeterRecord{MeterBatch: store.MeterBatch{UserID: x.user, RouteID: x.route, RawBytes: x.bytes, ObservedAt: now}, RateMicros: service.RateScale})
		if e != nil {
			t.Fatal(e)
		}
	}
	for _, owner := range []string{a.id, b.id} {
		err := s.Put("entry-admission-leases", "connection-"+owner, map[string]any{
			"id": "connection-" + owner, "binding": map[string]any{"userId": owner, "outputId": "owned-output-" + owner, "credentialVersion": "never-expose-credential", "subjectId": "never-expose-subject"},
			"clientIp": "192.0.2.8", "expiresAt": now.Add(30 * time.Second), "confirmedAt": now,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, x := range []struct {
		client *http.Client
		want   int
	}{{http.DefaultClient, 401}, {a.c, 200}, {b.c, 200}} {
		code, body, raw := req(t, x.client, "GET", srv.URL+"/api/me/insights", "", nil)
		if code != x.want {
			t.Fatalf("auth %d %s", code, raw)
		}
		if code == 200 {
			owner, foreign := a.id, b.id
			if x.client == b.c {
				owner, foreign = b.id, a.id
			}
			connections := body["admission"].(map[string]any)["connections"].([]any)
			if len(connections) != 1 || connections[0].(map[string]any)["outputId"] != "owned-output-"+owner || connections[0].(map[string]any)["lastConfirmedAt"] == nil {
				t.Fatalf("owned connection details %s", raw)
			}
			if strings.Contains(raw, "owned-output-"+foreign) || strings.Contains(raw, "never-expose") {
				t.Fatal("private connection evidence leaked")
			}
			if len(body["daily"].([]any)) != 14 || body["timezone"] != "UTC+8" {
				t.Fatalf("daily %s", raw)
			}
			if x.client == a.c && strings.Contains(raw, "secret-b-route") {
				t.Fatal("foreign usage leaked")
			}
			if x.client == a.c {
				limits := body["limits"].(map[string]any)
				if limits["onlineIpLimit"] != float64(2) || limits["connectionLimit"] != float64(3) || limits["entryRateBps"] != float64(1024) {
					t.Fatalf("effective limits %s", raw)
				}
				routes := body["routes"].([]any)
				if len(routes) != 1 || routes[0].(map[string]any)["rawBytes"] != float64(123) {
					t.Fatalf("own usage %s", raw)
				}
			}

			if _, ok := body["admission"].(map[string]any)["entries"]; ok {
				t.Fatal("private entry details exposed")
			}
			if _, ok := body["limits"].(map[string]any)["connectionLimit"]; !ok {
				t.Fatal("missing policy limits")
			}
		}
	}
	response, e := a.c.Get(srv.URL + "/api/me/insights")
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("private statistics may be cached")
	}
	code, _, raw := req(t, a.c, "GET", srv.URL+"/api/me/insights?userId="+b.id, "", nil)
	if code != 400 {
		t.Fatalf("caller-selected identity %d %s", code, raw)
	}
}
