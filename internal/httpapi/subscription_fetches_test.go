package httpapi_test

import (
	"encoding/json"
	"errors"
	"net/http"
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
