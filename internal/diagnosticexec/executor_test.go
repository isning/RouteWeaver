package diagnosticexec_test

import (
	"context"
	"errors"
	"net"
	"routeweaver/internal/diagnosticexec"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"strings"
	"testing"
	"time"
)

func routeJob(t *testing.T, url string) diagnostics.Job {
	t.Helper()
	scope := domain.InstanceScope{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch"}
	now := time.Now().UTC()
	job, e := diagnostics.NewJob(diagnostics.Request{ID: "job", InstanceID: "core", TargetID: "target", Kind: "connectivity", TimeoutSeconds: 1, PathMode: "managed_route", PublishedRouteID: "route"}, diagnostics.Target{ID: "target", Name: "Synthetic target policy", NodeID: "node", URL: url, Methods: []string{"connectivity"}}, scope, "admin", now)
	if e != nil {
		t.Fatal(e)
	}
	identity := domain.DeploymentIdentity{NodeID: "node", InstanceID: "core", EnrollmentEpoch: "epoch", AdapterID: "routeweaver/managed-xray", CoreVersion: "26.3.27-rw1", RevisionID: "revision", Generation: 1, Digest: strings.Repeat("a", 64)}
	job.ManagedPath = &diagnostics.ManagedPath{RouteID: "route", DeploymentID: "deployment", Fingerprint: strings.Repeat("a", 64), EntryEndpointID: "entry", ExitEndpointID: "entry", ConnectorID: "rw-direct", Hops: []diagnostics.PathHop{{EndpointID: "entry", Identity: identity}}}
	job.Status = "running"
	job.AttemptID = "attempt"
	job.ClaimedAt = &now
	return job
}
func TestManagedRouteAdapterPinsPublicLiteralAndNeverDialsDirectOnConnectorError(t *testing.T) {
	// Literal resolution performs no DNS or external connection. The route dialer
	// is a denying local fixture; this proves which destination would be carried.
	calls := 0
	executor := diagnosticexec.New(diagnosticexec.Options{RouteDialer: func(ctx context.Context, p diagnostics.ManagedPath, network, address string) (net.Conn, error) {
		calls++
		if network != "tcp" || address != "8.8.8.8:443" || p.RouteID != "route" {
			t.Errorf("unpinned destination: %s %s %+v", network, address, p)
		}
		return nil, errors.New("synthetic connector unavailable")
	}})
	result := executor.Execute(context.Background(), routeJob(t, "https://8.8.8.8/"))
	if result.Status != "failed" || calls != 1 || result.BytesPerSecond != nil || result.BytesReceived != 0 {
		t.Fatalf("result=%+v calls=%d", result, calls)
	}
}
func TestManagedRouteAdapterRejectsPrivateAndCredentialTargetsBeforeConnector(t *testing.T) {
	for _, url := range []string{"https://127.0.0.1/", "https://169.254.169.254/latest/meta-data/", "https://10.0.0.1/", "https://user:secret@8.8.8.8/", "https://8.8.8.8/?token=private"} {
		t.Run(url, func(t *testing.T) {
			calls := 0
			executor := diagnosticexec.New(diagnosticexec.Options{RouteDialer: func(context.Context, diagnostics.ManagedPath, string, string) (net.Conn, error) {
				calls++
				return nil, errors.New("must not dial")
			}})
			result := executor.Execute(context.Background(), routeJob(t, url))
			if result.Status != "not_run" || result.Code != "target_denied" || calls != 0 {
				t.Fatalf("unsafe target reached native connector %+v calls=%d", result, calls)
			}
		})
	}
}
