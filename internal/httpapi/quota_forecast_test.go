package httpapi_test

import (
	"net/http"
	"routeweaver/internal/domain"
	"strings"
	"testing"
)

func TestMyOverviewQuotaForecastIsPrivateOptionalAndNotBackfilled(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "forecast-a")
	b := inviteClient(t, s, srv, "forecast-b")
	for _, id := range []string{a.id, b.id} {
		var user domain.User
		if e := s.Get("users", id, &user); e != nil {
			t.Fatal(e)
		}
		user.QuotaBytes = 1000
		if e := s.PutUser(user); e != nil {
			t.Fatal(e)
		}
	}
	for _, tc := range []struct {
		client *http.Client
		want   int
		id     string
	}{{http.DefaultClient, 401, ""}, {a.c, 200, a.id}, {b.c, 200, b.id}} {
		code, body, raw := req(t, tc.client, "GET", srv.URL+"/api/me/overview?userId="+b.id, "", nil)
		if code != tc.want {
			t.Fatalf("status %d %s", code, raw)
		}
		if code != 200 {
			continue
		}
		if body["user"].(map[string]any)["id"] != tc.id {
			t.Fatal("caller-selected identity")
		}
		forecast, ok := body["quotaForecast"].(map[string]any)
		if !ok || forecast["available"] != false {
			t.Fatalf("historical/empty account fabricated forecast %s", raw)
		}
		if forecast["estimatedExhaustionAt"] != nil || forecast["enoughUntilHorizon"] != nil {
			t.Fatal("unproven estimate exposed")
		}
		if strings.Contains(raw, "dependencies") || strings.Contains(raw, "enrollmentEpoch") {
			t.Fatal("private proof exposed")
		}
	}
	response, e := a.c.Get(srv.URL + "/api/me/overview")
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("private forecast cacheable")
	}
	// A damaged optional forecast projection cannot make the existing overview fail.
	if e = s.Put("quota-coverage-safety", "unknown", "not-a-boolean"); e != nil {
		t.Fatal(e)
	}
	code, body, raw := req(t, a.c, "GET", srv.URL+"/api/me/overview", "", nil)
	if code != 200 || body["quotaForecast"] != nil || body["user"].(map[string]any)["id"] != a.id {
		t.Fatalf("optional error broke overview %d %s", code, raw)
	}
}
