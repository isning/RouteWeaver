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
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The driver cadence test and CP ACK test are intentionally joined here. The
// latter's clearServiceThrottle helper must not conceal a request/receipt timing
// mismatch. This remains real loopback traffic with synthetic fixture authority.
func TestNativeDelayedHeartbeatAcknowledgementPreservesExistingFlow(t *testing.T) {
	testNativeContinuousManagedServiceWithHeartbeatDelay(t, false, false, 500*time.Millisecond)
}

type heartbeatPolicySnapshot struct {
	Lease               controlprotocol.PolicyLease    `json:"lease"`
	PendingRefresh      *controlprotocol.PolicyRefresh `json:"pendingRefresh"`
	ValidationNotBefore time.Time                      `json:"validationNotBefore"`
}

// Only typed timestamps, status and an error type leave this fixture. Never log
// identities, tokens, raw bodies or database records to the native CI artifact.
type heartbeatScheduleEvent struct {
	Index                int32     `json:"index"`
	StartedAt            time.Time `json:"startedAt"`
	HandledAt            time.Time `json:"handledAt"`
	CompletedAt          time.Time `json:"completedAt"`
	FlowReadyAt          time.Time `json:"flowReadyAt"`
	DelayStartedAt       time.Time `json:"delayStartedAt"`
	DelayApplied         bool      `json:"delayApplied"`
	NegativeProbe        bool      `json:"negativeProbe"`
	ValidationNotBefore  time.Time `json:"validationNotBefore"`
	RequestPolicyIssued  time.Time `json:"requestPolicyIssued"`
	BeforePendingIssued  time.Time `json:"beforePendingIssued"`
	AfterPendingIssued   time.Time `json:"afterPendingIssued"`
	AfterLeaseIssued     time.Time `json:"afterLeaseIssued"`
	BeforeManifestExpiry time.Time `json:"beforeManifestExpiry"`
	AfterManifestExpiry  time.Time `json:"afterManifestExpiry"`
	Status               int       `json:"status"`
	ErrorType            string    `json:"errorType,omitempty"`
}

type delayedServiceHeartbeatProbe struct {
	f            fleetFixture
	desired      controlprotocol.Desired
	server       *httptest.Server
	delay        time.Duration
	calls        atomic.Int32
	mu           sync.Mutex
	events       []heartbeatScheduleEvent
	flowReady    chan struct{}
	flowReadyAt  time.Time
	delayStarted chan struct{}
}

const heartbeatNegativeProbeHeader = "X-RouteWeaver-Test-Early-Ack"

func newDelayedServiceHeartbeatProbe(t *testing.T, f fleetFixture, desired controlprotocol.Desired, next http.Handler, delay time.Duration) *delayedServiceHeartbeatProbe {
	t.Helper()
	p := &delayedServiceHeartbeatProbe{f: f, desired: desired, delay: delay, flowReady: make(chan struct{}), delayStarted: make(chan struct{}, 1)}
	p.server = httptest.NewServer(p.wrap(next))
	t.Cleanup(p.server.Close)
	t.Cleanup(func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		raw, err := json.Marshal(p.events)
		if err != nil {
			t.Errorf("heartbeat evidence encoding error_type=%s", referenceErrorType(err))
			return
		}
		t.Logf("controlled heartbeat receipt/ACK evidence: %s", raw)
	})
	return p
}

func (p *delayedServiceHeartbeatProbe) noteFlowEstablished() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.flowReadyAt = time.Now().UTC()
	close(p.flowReady)
}

func (p *delayedServiceHeartbeatProbe) snapshot() (heartbeatPolicySnapshot, domain.PublishedManifest, error) {
	var policy heartbeatPolicySnapshot
	var manifest domain.PublishedManifest
	if err := p.f.s.Get("agent-service-intents", p.desired.InstanceID, &policy); err != nil {
		return policy, manifest, err
	}
	err := p.f.s.Get("published-manifests", p.desired.RevisionID, &manifest)
	return policy, manifest, err
}

func (p *delayedServiceHeartbeatProbe) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if referenceRoute(r.URL.Path) != "service-heartbeat" {
			next.ServeHTTP(w, r)
			return
		}
		event := heartbeatScheduleEvent{Index: p.calls.Add(1), StartedAt: time.Now().UTC(), NegativeProbe: r.Header.Get(heartbeatNegativeProbeHeader) == "1"}
		defer func() {
			p.mu.Lock()
			defer p.mu.Unlock()
			if len(p.events) < 8 {
				p.events = append(p.events, event)
			}
		}()
		before, manifest, err := p.snapshot()
		if err != nil {
			event.ErrorType = referenceErrorType(err)
		}
		if err == nil && before.PendingRefresh == nil && before.Lease.IssuedAt == p.desired.Lease.IssuedAt {
			// Gate by authority state, never a request ordinal: slow startup can
			// make the very first heartbeat eligible to issue the refresh.
			// Both flow establishment and this delay consume the unchanged
			// one-second client deadline, without clearing the real CP throttle.
			select {
			case <-p.flowReady:
				p.mu.Lock()
				event.FlowReadyAt = p.flowReadyAt
				p.mu.Unlock()
			case <-r.Context().Done():
				event.CompletedAt = time.Now().UTC()
				event.ErrorType = referenceErrorType(r.Context().Err())
				return
			}
			event.DelayStartedAt = time.Now().UTC()
			event.DelayApplied = true
			timer := time.NewTimer(p.delay)
			defer timer.Stop()
			select {
			case p.delayStarted <- struct{}{}:
			default:
			}
			select {
			case <-timer.C:
			case <-r.Context().Done():
				event.CompletedAt = time.Now().UTC()
				event.ErrorType = referenceErrorType(r.Context().Err())
				return
			}
			before, manifest, err = p.snapshot()
			if err != nil {
				event.ErrorType = referenceErrorType(err)
			}
		}
		if err := r.Context().Err(); err != nil {
			event.CompletedAt = time.Now().UTC()
			event.ErrorType = referenceErrorType(err)
			return
		}
		event.ValidationNotBefore = before.ValidationNotBefore
		event.BeforeManifestExpiry = manifest.PolicyExpiresAt
		if before.PendingRefresh != nil {
			event.BeforePendingIssued = before.PendingRefresh.Lease.IssuedAt
		}
		request := &referenceCapture{}
		if r.Body != nil {
			r.Body = &referenceBody{Reader: io.TeeReader(r.Body, request), Closer: r.Body}
		}
		response := &referenceResponse{ResponseWriter: w}
		event.HandledAt = time.Now().UTC()
		next.ServeHTTP(response, r)
		event.CompletedAt = time.Now().UTC()
		event.Status = response.status
		var fact controlprotocol.ServiceHeartbeat
		if !request.overflow && json.Unmarshal(request.Bytes(), &fact) == nil {
			event.RequestPolicyIssued = fact.PolicyIssuedAt
		}
		after, manifest, err := p.snapshot()
		if err != nil {
			event.ErrorType = referenceErrorType(err)
		}
		event.AfterLeaseIssued = after.Lease.IssuedAt
		event.AfterManifestExpiry = manifest.PolicyExpiresAt
		if after.PendingRefresh != nil {
			event.AfterPendingIssued = after.PendingRefresh.Lease.IssuedAt
		}
	})
}

func (p *delayedServiceHeartbeatProbe) assertEarlyAckThrottled(t *testing.T, token string, fact controlprotocol.ServiceHeartbeat) {
	t.Helper()
	before, manifest, err := p.snapshot()
	if err != nil {
		t.Fatalf("heartbeat probe error_type=%s", referenceErrorType(err))
	}
	if before.PendingRefresh == nil || before.PendingRefresh.Lease.IssuedAt != fact.PolicyIssuedAt || manifest.PolicyExpiresAt != p.desired.Lease.ExpiresAt {
		t.Fatal("refresh was not pending with the original publication expiry")
	}
	// This is a separate negative protocol probe, never the driver's success
	// path or a retry of user traffic. It must not advance the manifest.
	fact.Observed.ObservedAt = time.Now().UTC()
	raw, err := json.Marshal(fact)
	if err != nil {
		t.Fatalf("heartbeat probe error_type=%s", referenceErrorType(err))
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, p.server.URL+"/api/agent/instances/"+fact.Desired.InstanceID+"/service-heartbeat", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("heartbeat probe error_type=%s", referenceErrorType(err))
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-RouteWeaver-Node", fact.Desired.NodeID)
	r.Header.Set("X-RouteWeaver-Enrollment", fact.Desired.EnrollmentEpoch)
	r.Header.Set(heartbeatNegativeProbeHeader, "1")
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatalf("early ACK request error_type=%s", referenceErrorType(err))
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("early ACK status=%d, want throttled 204", response.StatusCode)
	}
	if !time.Now().Before(before.ValidationNotBefore) {
		t.Fatal("negative ACK did not complete inside the real CP throttle window")
	}
	after, manifest, err := p.snapshot()
	if err != nil {
		t.Fatalf("heartbeat probe error_type=%s", referenceErrorType(err))
	}
	if after.PendingRefresh == nil || *after.PendingRefresh != *before.PendingRefresh || after.Lease != before.Lease || after.ValidationNotBefore != before.ValidationNotBefore || manifest.PolicyExpiresAt != p.desired.Lease.ExpiresAt {
		t.Fatal("throttled 204 changed pending authority or publication expiry")
	}
}

func (p *delayedServiceHeartbeatProbe) requireDriverAcknowledgement(t *testing.T, issued time.Time) {
	t.Helper()
	// Keep the actual old lease as the deadline. Advancing it or forcing the
	// throttle open would erase the failure this regression must expose.
	for time.Now().Before(p.desired.Lease.ExpiresAt) {
		policy, manifest, err := p.snapshot()
		if err != nil {
			t.Fatalf("heartbeat probe error_type=%s", referenceErrorType(err))
		}
		p.mu.Lock()
		events := append([]heartbeatScheduleEvent(nil), p.events...)
		p.mu.Unlock()
		for _, event := range events {
			if event.ErrorType != "" {
				t.Fatal("heartbeat evidence snapshot failed: " + event.ErrorType)
			}
		}
		seenACK, committedACK := checkFirstDriverACK(events, issued, p.desired.Lease.ExpiresAt)
		if seenACK && !committedACK {
			t.Fatal("first Driver ACK did not advance authority; later ACKs cannot conceal a throttle-window miss")
		}
		if policy.PendingRefresh == nil && policy.Lease.IssuedAt == issued && policy.Lease.ExpiresAt.After(p.desired.Lease.ExpiresAt) && manifest.PolicyExpiresAt == policy.Lease.ExpiresAt {
			delayedRefresh := false
			for _, event := range events {
				if event.DelayApplied && !event.FlowReadyAt.IsZero() && !event.DelayStartedAt.IsZero() && !event.DelayStartedAt.Before(event.FlowReadyAt) && event.Status == http.StatusOK && event.HandledAt.Sub(event.DelayStartedAt) >= p.delay && event.RequestPolicyIssued == p.desired.Lease.IssuedAt && event.BeforePendingIssued.IsZero() && event.AfterPendingIssued == issued && event.BeforeManifestExpiry == p.desired.Lease.ExpiresAt && event.AfterManifestExpiry == p.desired.Lease.ExpiresAt {
					delayedRefresh = true
				}
			}
			if !delayedRefresh {
				t.Fatal("controlled request delay did not issue the pending refresh")
			}
			if seenACK && committedACK {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("driver did not acknowledge the issued refresh and advance the manifest before original lease expiry")
}

// A refresh issued on the first heartbeat leaves enough lease time for a second
// ACK attempt. Do not let that later success hide a first-ACK cadence regression.
func checkFirstDriverACK(events []heartbeatScheduleEvent, issued, oldExpiry time.Time) (seen, committed bool) {
	var first heartbeatScheduleEvent
	for _, event := range events {
		if event.NegativeProbe || event.RequestPolicyIssued != issued {
			continue
		}
		if !seen || event.Index < first.Index {
			first, seen = event, true
		}
	}
	committed = seen && !first.DelayApplied && first.Status == http.StatusNoContent && first.BeforePendingIssued == issued && first.AfterPendingIssued.IsZero() && first.AfterLeaseIssued == issued && first.BeforeManifestExpiry == oldExpiry && first.AfterManifestExpiry.After(oldExpiry) && !first.HandledAt.Before(first.ValidationNotBefore) && first.CompletedAt.Before(oldExpiry)
	return seen, committed
}
