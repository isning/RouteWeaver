package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"routeweaver/internal/controlprotocol"
	"testing"
	"time"
)

func TestServiceHeartbeatTransportScopesAndStrictlyDecodesRefresh(t *testing.T) {
	for _, scenario := range []string{"valid", "wrong_identity", "unknown_field", "trailing", "no_refresh"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDesired(t, 1)
			h := controlprotocol.ServiceHeartbeat{Desired: d.Identity(), Observed: Observation{Identity: d.Identity(), Known: true, Quiescent: true, ObservedAt: time.Now().UTC()}, PolicyIssuedAt: d.Lease.IssuedAt, ServiceActive: true}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/agent/instances/core-a/service-heartbeat" || r.Header.Get("Authorization") != "Bearer fixture-scope-token" || r.Header.Get("X-RouteWeaver-Enrollment") != d.EnrollmentEpoch {
					t.Error("unscoped heartbeat")
				}
				var received controlprotocol.ServiceHeartbeat
				if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
					t.Error(err)
				}
				if received.Desired != d.Identity() || !received.Observed.Known {
					t.Error("runtime identity lost")
				}
				if scenario == "no_refresh" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				if scenario == "unknown_field" {
					w.Write([]byte(`{"unexpected":true}`))
					return
				}
				result := controlprotocol.ServiceHeartbeatResult{PolicyRefresh: &controlprotocol.PolicyRefresh{Identity: d.Identity(), IntentID: "service-intent", Sequence: 1, Lease: d.Lease}}
				if scenario == "wrong_identity" {
					result.PolicyRefresh.Identity.Generation++
				}
				json.NewEncoder(w).Encode(result)
				if scenario == "trailing" {
					w.Write([]byte(`{}`))
				}
			}))
			defer server.Close()
			tr, err := NewHTTPTransport(HTTPTransportOptions{BaseURL: server.URL, Token: "fixture-scope-token", Scope: d.Scope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
			if err != nil {
				t.Fatal(err)
			}
			defer tr.Close()
			result, err := tr.SendServiceHeartbeat(context.Background(), h)
			if scenario == "valid" {
				if err != nil || result.PolicyRefresh == nil || result.PolicyRefresh.Sequence != 1 {
					t.Fatalf("valid refresh rejected: %+v %v", result, err)
				}
			} else if scenario == "no_refresh" {
				if err != nil || result.PolicyRefresh != nil {
					t.Fatal("empty heartbeat response failed")
				}
			} else if err == nil {
				t.Fatal("invalid response accepted")
			}
			h.Desired.EnrollmentEpoch = "different"
			if _, err = tr.SendServiceHeartbeat(context.Background(), h); err == nil {
				t.Fatal("wrong scope sent")
			}
		})
	}
}
