package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"routeweaver/internal/controlprotocol"
	"sync/atomic"
	"testing"
	"time"
)

func TestPolicyRefreshExtendsOnlyObservedIdentityWithoutActivation(t *testing.T) {
	now := time.Now().UTC()
	d := testDesired(t, 1)
	d.Lease.IssuedAt = now.Add(-time.Second)
	d.Lease.ExpiresAt = now.Add(time.Minute)
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	r, err := Open(root, d.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: time.Hour, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err = r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(root, "fixture-observation.json"))
	if err != nil {
		t.Fatal(err)
	}
	hb, err := r.ServiceHeartbeat(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !hb.ServiceActive || hb.Observed.Identity != d.Identity() || !hb.Observed.Known {
		t.Fatal("missing actual runtime fact")
	}
	refresh := controlprotocol.PolicyRefresh{Identity: d.Identity(), IntentID: "service-intent", Sequence: 1, Lease: d.Lease}
	refresh.Lease.IssuedAt = now
	refresh.Lease.ExpiresAt = now.Add(30 * time.Minute)
	if _, err = r.ApplyPolicyRefresh(context.Background(), refresh); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(filepath.Join(root, "fixture-observation.json"))
	if err != nil || string(after) != string(before) {
		t.Fatal("lease refresh mutated runtime")
	}
	now = now.Add(2 * time.Minute)
	if st, err := r.Recover(context.Background()); err != nil || st.Phase != ObservedConformant {
		t.Fatalf("refreshed lease lost: %+v %v", st, err)
	}
	r.Close()
	r, err = Open(root, d.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: time.Hour, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if st, err := r.Recover(context.Background()); err != nil || st.Phase != ObservedConformant {
		t.Fatalf("restart lost durable refresh: %+v %v", st, err)
	}
	if _, err = r.Submit(context.Background(), d); err != nil {
		t.Fatal("original immutable desired retry changed", err)
	}
}

func TestPolicyRefreshRejectsStaleUnsafeOrUnobservedAuthority(t *testing.T) {
	for _, scenario := range []string{"wrong_identity", "changed_policy", "zero_sequence", "old_issue", "future_issue", "denied", "quota_unknown", "expired_grant", "expired_current", "absent", "unknown", "superseded", "write_failure"} {
		t.Run(scenario, func(t *testing.T) {
			now := time.Now().UTC()
			d := testDesired(t, 1)
			d.Lease.IssuedAt = now.Add(-time.Second)
			d.Lease.ExpiresAt = now.Add(time.Minute)
			root := t.TempDir()
			if err := os.Chmod(root, 0700); err != nil {
				t.Fatal(err)
			}
			r, err := Open(root, d.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: time.Hour, Now: func() time.Time { return now }})
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			if _, err = r.Submit(context.Background(), d); err != nil {
				t.Fatal(err)
			}
			u := controlprotocol.PolicyRefresh{Identity: d.Identity(), IntentID: "service-intent", Sequence: 1, Lease: d.Lease}
			u.Lease.IssuedAt = now
			u.Lease.ExpiresAt = now.Add(30 * time.Minute)
			switch scenario {
			case "wrong_identity":
				u.Identity.Generation++
			case "changed_policy":
				u.Lease.Revision = "different-policy"
			case "zero_sequence":
				u.Sequence = 0
			case "old_issue":
				u.Lease.IssuedAt = d.Lease.IssuedAt
			case "future_issue":
				u.Lease.IssuedAt = now.Add(time.Minute)
			case "denied":
				u.Lease.AccessAllowed = false
			case "quota_unknown":
				u.Lease.QuotaCertain = false
			case "expired_grant":
				u.Lease.ExpiresAt = now
			case "expired_current":
				now = now.Add(2 * time.Minute)
			case "absent":
				if err = (LocalFixture{}).Restrict(context.Background(), root); err != nil {
					t.Fatal(err)
				}
			case "unknown":
				if err = os.WriteFile(filepath.Join(root, "fixture-observation.json"), []byte("bad-json"), 0600); err != nil {
					t.Fatal(err)
				}
			case "superseded":
				newer := d
				newer.Generation = 2
				newer.OperationID = "denial"
				newer.Lease.AccessAllowed = false
				_, _ = r.Submit(context.Background(), newer)
			case "write_failure":
				if err = os.Chmod(root, 0500); err != nil {
					t.Fatal(err)
				}
				defer os.Chmod(root, 0700)
			}
			if _, err = r.ApplyPolicyRefresh(context.Background(), u); err == nil {
				t.Fatal("unsafe refresh accepted")
			}
			if scenario == "write_failure" {
				if err = os.Chmod(root, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if scenario != "unknown" {
				now = now.Add(2 * time.Minute)
				st, _ := r.EnforcePolicy(context.Background())
				if st.Observed != nil {
					t.Fatal("rejected refresh extended authority")
				}
			}
		})
	}
}

func TestPolicyRefreshSequenceSurvivesReopenAndCannotChangeIntent(t *testing.T) {
	now := time.Now().UTC()
	d := testDesired(t, 1)
	d.Lease.IssuedAt = now.Add(-time.Second)
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	open := func() *Reconciler {
		r, err := Open(root, d.Scope, NewRegistry(LocalFixture{}), Options{MaxLease: 2 * time.Hour, Now: func() time.Time { return now }})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	r := open()
	defer r.Close()
	if _, err := r.Submit(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	u := controlprotocol.PolicyRefresh{Identity: d.Identity(), IntentID: "service-intent", Sequence: 7, Lease: d.Lease}
	u.Lease.IssuedAt = now
	u.Lease.ExpiresAt = now.Add(time.Hour)
	if _, err := r.ApplyPolicyRefresh(context.Background(), u); err != nil {
		t.Fatal(err)
	}
	r.Close()
	r = open()
	defer r.Close()
	if _, err := r.ApplyPolicyRefresh(context.Background(), u); err != nil {
		t.Fatal("exact retry rejected", err)
	}
	now = now.Add(time.Second)
	for _, v := range []controlprotocol.PolicyRefresh{u, u} {
		v.Lease.IssuedAt = now
		v.Sequence = 6
		if _, err := r.ApplyPolicyRefresh(context.Background(), v); err == nil {
			t.Fatal("old sequence accepted")
		}
		v.Sequence = 8
		v.IntentID = "different-intent"
		if _, err := r.ApplyPolicyRefresh(context.Background(), v); err == nil {
			t.Fatal("intent switch accepted without new generation")
		}
	}
}

type renewingDriverTransport struct {
	driverTransport
	calls atomic.Int32
	slow  bool
}

func (t *renewingDriverTransport) SendServiceHeartbeat(ctx context.Context, h controlprotocol.ServiceHeartbeat) (controlprotocol.ServiceHeartbeatResult, error) {
	t.calls.Add(1)
	if t.slow {
		<-ctx.Done()
		return controlprotocol.ServiceHeartbeatResult{}, ctx.Err()
	}
	now := time.Now().UTC()
	return controlprotocol.ServiceHeartbeatResult{PolicyRefresh: &controlprotocol.PolicyRefresh{Identity: h.Desired, IntentID: "service-intent", Sequence: 1, Lease: PolicyLease{Revision: "policy-a", IssuedAt: now, ExpiresAt: now.Add(time.Minute), AccessAllowed: true, QuotaCertain: true}}}, nil
}
func TestContinuousDriverRenewsWithoutBlockingIndependentLeaseEnforcement(t *testing.T) {
	for _, slow := range []bool{false, true} {
		t.Run(fmt.Sprint(slow), func(t *testing.T) {
			r := openTest(t, t.TempDir(), LocalFixture{})
			d := testDesired(t, 1)
			d.Lease.ExpiresAt = time.Now().Add(150 * time.Millisecond)
			tr := &renewingDriverTransport{driverTransport: driverTransport{desired: &d}, slow: slow}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := RunDriver(ctx, r, tr, nil, DriverOptions{Continuous: true, PollInterval: 5 * time.Millisecond, LeaseInterval: 5 * time.Millisecond})
				done <- err
			}()
			time.Sleep(250 * time.Millisecond)
			st := r.State()
			if tr.calls.Load() != 1 {
				t.Fatalf("heartbeat absent or unbounded frequency: %d", tr.calls.Load())
			}
			if slow {
				if st.Observed != nil || st.AccessDecision != "lease_expired" {
					t.Fatalf("slow refresh blocked expiry: %+v", st)
				}
			} else if st.Phase != ObservedConformant || st.Observed == nil || st.Observed.Identity != d.Identity() {
				t.Fatalf("renewal changed runtime or failed: %+v", st)
			}
			cancel()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestBoundedDriverNeverOptsIntoServiceHeartbeats(t *testing.T) {
	r := openTest(t, t.TempDir(), LocalFixture{})
	d := testDesired(t, 1)
	tr := &renewingDriverTransport{driverTransport: driverTransport{desired: &d}}
	if _, err := RunDriver(context.Background(), r, tr, nil, DriverOptions{MaxRuntime: 30 * time.Millisecond, PollInterval: time.Millisecond, LeaseInterval: time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	if tr.calls.Load() != 0 {
		t.Fatal("bounded driver silently requested perpetual authority")
	}
}
