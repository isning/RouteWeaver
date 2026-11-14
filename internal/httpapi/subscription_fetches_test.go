package httpapi_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

func TestSubscriptionFetchHistoryTracksDeliveriesWithoutSecretsOrCrossOwnerData(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "fetch-owner")
	other := inviteClient(t, s, srv, "fetch-other")
	output := createAccessRevisionOutput(t, owner, srv.URL, "phone")
	assertAccessRevisionFeed(t, srv.URL, output, 200)
	code, _, body := req(t, owner.c, "GET", srv.URL+"/api/me/subscription-fetches?owner=fetch-other", "", nil)
	var history store.SubscriptionFetchHistory
	if code != 200 || json.Unmarshal([]byte(body), &history) != nil || len(history.Items) != 2 {
		t.Fatalf("history %d %s", code, body)
	}
	if history.CollectionStartedAt == nil || history.Items[0].OutputID != "phone" || history.Items[0].Delivery != "bundle" || history.Items[1].Delivery != "feed" {
		t.Fatal("wrong delivery history")
	}
	if strings.Contains(body, "token") || strings.Contains(body, "127.0.0.1") || strings.Contains(body, "User-Agent") {
		t.Fatal("private request metadata leaked")
	}
	code, _, body = req(t, other.c, "GET", srv.URL+"/api/me/subscription-fetches?owner=fetch-owner", "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &history) != nil || len(history.Items) != 0 {
		t.Fatalf("cross-user history %s", body)
	}
	resp, err := http.Get(srv.URL + "/api/me/subscription-fetches")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("unauthenticated history")
	}
	// A disconnected writer must not count as successful delivery.
	bad := &failedFetchWriter{header: make(http.Header)}
	request, _ := http.NewRequest("GET", srv.URL+output["feedPath"].(string), nil)
	srv.Config.Handler.ServeHTTP(bad, request)
	// Invalid bearer links do not reveal or create history for guessed outputs.
	resp, err = http.Get(srv.URL + "/s/" + strings.Repeat("x", 43))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	code, _, body = req(t, owner.c, "GET", srv.URL+"/api/me/subscription-fetches", "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &history) != nil || len(history.Items) != 2 {
		t.Fatal("failed request changed history")
	}
}

type failedFetchWriter struct{ header http.Header }

func (w *failedFetchWriter) Header() http.Header       { return w.header }
func (w *failedFetchWriter) WriteHeader(int)           {}
func (w *failedFetchWriter) Write([]byte) (int, error) { return 0, errors.New("disconnected") }

func TestSubscriptionFetchTrackingOwnerOptInAndUntrustedForwarding(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "tracking-owner")
	other := inviteClient(t, s, srv, "tracking-other")
	output := createAccessRevisionOutput(t, owner, srv.URL, "phone")
	endpoint := srv.URL + "/api/me/subscription-fetches/tracking"
	if code, _, _ := req(t, owner.c, "PUT", endpoint, "", map[string]any{"enabled": true}); code != 403 {
		t.Fatalf("missing CSRF: %d", code)
	}
	if code, _, _ := req(t, owner.c, "PUT", endpoint, owner.csrf, map[string]any{}); code != 400 {
		t.Fatalf("missing choice: %d", code)
	}
	code, _, raw := req(t, owner.c, "PUT", endpoint+"?owner=tracking-other", owner.csrf, map[string]any{"enabled": true})
	if code != 200 {
		t.Fatalf("enable %d %s", code, raw)
	}
	// Forged forwarding headers from the direct peer must not become stored addresses.
	for _, forwarded := range []string{"192.0.2.1", "192.0.2.2"} {
		request, _ := http.NewRequest("GET", srv.URL+output["feedPath"].(string), nil)
		request.Header.Set("X-Forwarded-For", forwarded)
		response, e := http.DefaultClient.Do(request)
		if e != nil {
			t.Fatal(e)
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal(response.StatusCode)
		}
	}
	code, _, raw = req(t, owner.c, "GET", srv.URL+"/api/me/subscription-fetches", "", nil)
	var h store.SubscriptionFetchHistory
	if code != 200 || json.Unmarshal([]byte(raw), &h) != nil || !h.TrackSourceIPs {
		t.Fatalf("history %s", raw)
	}
	if h.Items[0].SourceIP != "127.0.0.1" || h.Items[0].NewSource {
		t.Fatalf("forged header or false alert: %+v", h.Items[0])
	}
	trusted := httpapi.NewWithOptions(s, render.Default(), httpapi.Options{TrustedProxyCIDRs: []string{"127.0.0.1/32", "10.0.0.0/24"}})
	for _, tc := range []struct {
		xff, want string
		alert     bool
	}{
		{"203.0.113.99, 192.0.2.15, 10.0.0.5", "192.0.2.15", true},
		{"198.51.100.99, 192.0.2.15, 10.0.0.5", "192.0.2.15", false},
		{"invalid, 10.0.0.5", "127.0.0.1", false},
	} {
		request := httptest.NewRequest("GET", output["feedPath"].(string), nil)
		request.RemoteAddr = "127.0.0.1:4567"
		request.Header.Set("X-Forwarded-For", tc.xff)
		recorder := httptest.NewRecorder()
		trusted.ServeHTTP(recorder, request)
		if recorder.Code != 200 {
			t.Fatalf("trusted feed %d %s", recorder.Code, recorder.Body.String())
		}
		_, _, raw = req(t, owner.c, "GET", srv.URL+"/api/me/subscription-fetches", "", nil)
		h = store.SubscriptionFetchHistory{}
		if json.Unmarshal([]byte(raw), &h) != nil || h.Items[0].SourceIP != tc.want || h.Items[0].NewSource != tc.alert {
			t.Fatalf("trusted chain result %s", raw)
		}
	}
	_, _, raw = req(t, other.c, "GET", srv.URL+"/api/me/subscription-fetches", "", nil)
	if json.Unmarshal([]byte(raw), &h) != nil || h.TrackSourceIPs || len(h.Items) != 0 {
		t.Fatalf("cross owner %s", raw)
	}
	code, _, raw = req(t, owner.c, "PUT", endpoint, owner.csrf, map[string]any{"enabled": false})
	if code != 200 || strings.Contains(raw, "sourceIp") || strings.Contains(raw, "newSource") {
		t.Fatalf("disable: %d %s", code, raw)
	}
}
