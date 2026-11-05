package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"sync/atomic"
	"testing"
	"time"
)

// Only the optional warmup 204 is synthetic here. Refresh issuance and the
// negative ACK use the real CP. Native traffic remains a separate required test.
func TestDelayedHeartbeatProbeFollowsRefreshStateNotRequestIndex(t *testing.T) {
	for _, warmup := range []bool{false, true} {
		name := "first-request-refresh"
		if warmup {
			name = "warmup-before-refresh"
		}
		t.Run(name, func(t *testing.T) {
			f, token, desired := heartbeatProbeFixture(t)
			var calls atomic.Int32
			next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if warmup && calls.Add(1) == 1 {
					_, _ = io.Copy(io.Discard, r.Body)
					w.WriteHeader(http.StatusNoContent)
					return
				}
				f.srv.Config.Handler.ServeHTTP(w, r)
			})
			probe := newDelayedServiceHeartbeatProbe(t, f, desired, next, time.Millisecond)
			probe.noteFlowEstablished()
			fact := liveServiceFact(desired)
			if warmup {
				response := probeHeartbeatRequest(t, probe, token, fact)
				if response.Code != http.StatusNoContent {
					t.Fatalf("warmup status=%d", response.Code)
				}
			}
			response := probeHeartbeatRequest(t, probe, token, fact)
			var result controlprotocol.ServiceHeartbeatResult
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.PolicyRefresh == nil {
				t.Fatalf("real CP did not issue refresh: status=%d", response.Code)
			}
			probe.mu.Lock()
			event := probe.events[len(probe.events)-1]
			probe.mu.Unlock()
			if !event.DelayApplied || event.FlowReadyAt.IsZero() || event.DelayStartedAt.Before(event.FlowReadyAt) || event.HandledAt.Sub(event.DelayStartedAt) < probe.delay || !event.BeforePendingIssued.IsZero() || event.AfterPendingIssued != result.PolicyRefresh.Lease.IssuedAt || event.AfterManifestExpiry != desired.Lease.ExpiresAt {
				t.Fatal("refresh was not delayed after flow readiness with original manifest intact")
			}
			fact.PolicyIssuedAt = result.PolicyRefresh.Lease.IssuedAt
			probe.assertEarlyAckThrottled(t, token, fact)
			// The negative probe uses HTTP; its server-side evidence must finish
			// before inspecting it, without retrying the heartbeat itself.
			deadline := time.Now().Add(time.Second)
			for {
				probe.mu.Lock()
				last := probe.events[len(probe.events)-1]
				probe.mu.Unlock()
				if last.RequestPolicyIssued == fact.PolicyIssuedAt {
					if last.DelayApplied || last.Status != http.StatusNoContent || last.BeforePendingIssued != fact.PolicyIssuedAt || last.AfterPendingIssued != fact.PolicyIssuedAt {
						t.Fatal("pending-refresh early ACK was delayed or advanced authority")
					}
					break
				}
				if !time.Now().Before(deadline) {
					t.Fatal("early ACK evidence did not complete")
				}
				time.Sleep(time.Millisecond)
			}
		})
	}
}

func TestDelayedHeartbeatProbeDoesNotEnterCPBeforeFlowOrAfterCancellation(t *testing.T) {
	for _, ready := range []bool{false, true} {
		name := "waiting-for-flow"
		if ready {
			name = "waiting-for-delay"
		}
		t.Run(name, func(t *testing.T) {
			f, token, desired := heartbeatProbeFixture(t)
			var entered atomic.Int32
			probe := newDelayedServiceHeartbeatProbe(t, f, desired, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				entered.Add(1)
				f.srv.Config.Handler.ServeHTTP(w, r)
			}), 500*time.Millisecond)
			if ready {
				probe.noteFlowEstablished()
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			request := heartbeatProbeRequest(t, probe, token, liveServiceFact(desired)).WithContext(ctx)
			done := make(chan struct{})
			go func() {
				probe.server.Config.Handler.ServeHTTP(httptest.NewRecorder(), request)
				close(done)
			}()
			t.Cleanup(func() {
				cancel()
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Error("canceled heartbeat fixture did not return")
				}
			})
			for probe.calls.Load() == 0 && ctx.Err() == nil {
				time.Sleep(time.Millisecond)
			}
			if probe.calls.Load() == 0 || entered.Load() != 0 {
				t.Fatal("CP handler entered before controlled readiness/delay")
			}
			if ready {
				select {
				case <-probe.delayStarted:
				case <-ctx.Done():
					t.Fatal("controlled delay never started")
				}
			}
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("canceled heartbeat did not return")
			}
			if entered.Load() != 0 {
				t.Fatal("canceled controlled heartbeat entered CP")
			}
			policy, manifest, err := probe.snapshot()
			if err != nil || policy.PendingRefresh != nil || policy.Lease != desired.Lease || manifest.PolicyExpiresAt != desired.Lease.ExpiresAt {
				t.Fatal("canceled fixture changed authority")
			}
		})
	}
}

func TestDelayedHeartbeatProbeRejectsFirstACKMissDespiteLaterSuccess(t *testing.T) {
	expiry := time.Date(2026, time.November, 5, 0, 0, 15, 0, time.UTC)
	issued := expiry.Add(-10 * time.Second)
	good := heartbeatScheduleEvent{Index: 4, RequestPolicyIssued: issued, BeforePendingIssued: issued, AfterLeaseIssued: issued, BeforeManifestExpiry: expiry, AfterManifestExpiry: expiry.Add(5 * time.Minute), Status: http.StatusNoContent, ValidationNotBefore: issued.Add(5 * time.Second), HandledAt: issued.Add(5 * time.Second), CompletedAt: issued.Add(6 * time.Second)}
	early := good
	early.Index = 3
	early.HandledAt = issued.Add(4 * time.Second)
	early.CompletedAt = early.HandledAt
	early.AfterPendingIssued = issued
	early.AfterLeaseIssued = issued.Add(-300 * time.Second)
	early.AfterManifestExpiry = expiry
	negative := early
	negative.Index = 2
	negative.NegativeProbe = true
	for _, tc := range []struct {
		name      string
		events    []heartbeatScheduleEvent
		seen      bool
		committed bool
	}{
		{"only-negative", []heartbeatScheduleEvent{negative}, false, false},
		{"first-driver-ack-commits", []heartbeatScheduleEvent{negative, good}, true, true},
		{"later-success-cannot-hide-early-ack", []heartbeatScheduleEvent{negative, early, good}, true, false},
		{"completion-order-does-not-hide-early-ack", []heartbeatScheduleEvent{good, negative, early}, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			seen, committed := checkFirstDriverACK(tc.events, issued, expiry)
			if seen != tc.seen || committed != tc.committed {
				t.Fatalf("first Driver ACK seen=%t committed=%t, want %t/%t", seen, committed, tc.seen, tc.committed)
			}
		})
	}
}

func heartbeatProbeFixture(t *testing.T) (fleetFixture, string, controlprotocol.Desired) {
	t.Helper()
	f, _, token, desired := continuousFixture(t)
	ageContinuousLease(t, f, &desired)
	var manifest domain.PublishedManifest
	if err := f.s.Get("published-manifests", desired.RevisionID, &manifest); err != nil {
		t.Fatal("fixture manifest read failed")
	}
	manifest.PolicyExpiresAt = desired.Lease.ExpiresAt
	if err := f.s.Put("published-manifests", desired.RevisionID, manifest); err != nil {
		t.Fatal("fixture manifest setup failed")
	}
	return f, token, desired
}

func heartbeatProbeRequest(t *testing.T, probe *delayedServiceHeartbeatProbe, token string, fact controlprotocol.ServiceHeartbeat) *http.Request {
	t.Helper()
	raw, err := json.Marshal(fact)
	if err != nil {
		t.Fatal("fixture heartbeat encoding failed")
	}
	r := httptest.NewRequest(http.MethodPost, probe.server.URL+"/api/agent/instances/"+fact.Desired.InstanceID+"/service-heartbeat", bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-RouteWeaver-Node", fact.Desired.NodeID)
	r.Header.Set("X-RouteWeaver-Enrollment", fact.Desired.EnrollmentEpoch)
	return r
}

func probeHeartbeatRequest(t *testing.T, probe *delayedServiceHeartbeatProbe, token string, fact controlprotocol.ServiceHeartbeat) *httptest.ResponseRecorder {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	response := httptest.NewRecorder()
	probe.server.Config.Handler.ServeHTTP(response, heartbeatProbeRequest(t, probe, token, fact).WithContext(ctx))
	return response
}
