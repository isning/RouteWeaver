package httpapi_test

import (
	"net/http"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestPrivateExternalFeedDoesNotConsumePlatformServiceEligibility(t *testing.T) {
	for _, condition := range []string{"exhausted", "expired"} {
		t.Run(condition, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "private-converter")
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, templateTestProfile("external", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}))
			if code != 200 {
				t.Fatal(raw)
			}
			code, output, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]string{"id": "external", "name": "Private airport", "profileId": "external"})
			if code != 201 {
				t.Fatal(raw)
			}
			now := time.Now().UTC()
			expiry := now.Add(time.Hour)
			if condition == "expired" {
				expiry = now.Add(-time.Minute)
			}
			if err := s.Put("services", "limited", service.Plan{ID: "limited", Name: "Platform", QuotaBytes: 1}); err != nil {
				t.Fatal(err)
			}
			if err := s.Put("entitlements", u.id, service.Entitlement{UserID: u.id, ServiceID: "limited", StartsAt: now.Add(-time.Hour), ExpiresAt: &expiry, Cycle: service.CyclePolicy{Mode: "none"}}); err != nil {
				t.Fatal(err)
			}
			if condition == "exhausted" {
				if err := s.RecordMeter(store.MeterBatch{UserID: u.id, RouteID: "platform-route", MeterID: "fixture", Epoch: "fixture", Sequence: 1, RawBytes: 1, ObservedAt: now}); err != nil {
					t.Fatal(err)
				}
			}
			feed := srv.URL + output["feedPath"].(string)
			response, err := http.Get(feed)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatalf("private conversion incorrectly inherits platform%s: %d", condition, response.StatusCode)
			}
			if response.Header.Get("Subscription-Userinfo") != "" {
				t.Fatal("platform billing attached to private external airport feed")
			}
			// A platform-dependent output remains subject to service authorization.
			var saved httpapi.Output
			if err := s.TenantGet(u.id, "outputs", "external", &saved); err != nil {
				t.Fatal(err)
			}
			original := saved
			saved.PlatformDependencies = []httpapi.EntryDependency{{ID: "platform-entry", RouteID: "platform-route", CredentialVersion: "v1"}}
			if err := s.TenantPut(u.id, "outputs", "external", saved); err != nil {
				t.Fatal(err)
			}
			response, err = http.Get(feed)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 403 {
				t.Fatal("platform dependency bypassed eligibility")
			}
			if err := s.TenantPut(u.id, "outputs", "external", original); err != nil {
				t.Fatal(err)
			}
			var account store.Account
			if err := s.Get("accounts", u.id, &account); err != nil {
				t.Fatal(err)
			}
			account.Disabled = true
			if err := s.Put("accounts", u.id, account); err != nil {
				t.Fatal(err)
			}
			response, err = http.Get(feed)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 403 {
				t.Fatal("disabled account retained private feed access")
			}
			account.Disabled = false
			s.Put("accounts", u.id, account)
			if err := s.PutUser(domain.User{ID: u.id, Name: "Disabled", Enabled: false}); err != nil {
				t.Fatal(err)
			}
			response, err = http.Get(feed)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 403 {
				t.Fatal("disabled user retained private feed access")
			}
		})
	}
}
