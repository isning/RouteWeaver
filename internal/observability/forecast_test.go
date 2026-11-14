package observability_test

import (
	"routeweaver/internal/observability"
	"testing"
	"time"
)

func forecastFixture(t *testing.T) (observability.State, observability.Report, time.Time) {
	s, r, now := fixture(t)
	s.Config.Provider.CycleStart = now.Add(-time.Hour)
	s.Config.Provider.CycleEnd = now.Add(7 * 24 * time.Hour)
	var err error
	s, err = observability.Reconcile(s, observability.BaselineInput{CycleID: "cycle", UsedBytes: 799000000000, ReportDigest: r.Digest, Reason: "checked provider"}, "admin", now)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1440; i++ {
		r = advance(r)
		s, _, err = observability.Accept(s, r, r.ObservedAt)
		if err != nil {
			t.Fatal(err)
		}
	}
	return s, r, r.ObservedAt
}
func TestForecastRequiresContinuousReconciledDay(t *testing.T) {
	s, r, now := forecastFixture(t)
	v := observability.ViewOf("node", s, now)
	if v.Forecast.Status != "beyond_horizon" || v.Forecast.AverageBytesPerSecond == nil || *v.Forecast.AverageBytesPerSecond != 5 {
		t.Fatalf("bad real rate %+v", v.Forecast)
	}
	s.Baseline.UsedBytes = 799999000000
	v = observability.ViewOf("node", s, now)
	if v.Forecast.Status != "estimated" || v.Forecast.ExhaustedAt == nil || !v.Forecast.ExhaustedAt.Equal(now.Add(113600*time.Second)) {
		t.Fatalf("wrong projection %+v", v.Forecast)
	}
	rebased, err := observability.Reconcile(s, observability.BaselineInput{CycleID: "cycle", UsedBytes: 799999500000, ReportDigest: r.Digest, Reason: "new statement"}, "admin", now)
	if err != nil {
		t.Fatal(err)
	}
	if f := observability.ViewOf("node", rebased, now).Forecast; f.Status != "unavailable" {
		t.Fatal("new baseline reused old rate", f)
	}
	changed := s.Config
	changed.BilledInterfaces = []string{"eth1"}
	reset, err := observability.Configure(s, changed)
	if err != nil {
		t.Fatal(err)
	}
	if f := observability.ViewOf("node", reset, now).Forecast; f.Status != "unavailable" {
		t.Fatal("changed scope reused old rate", f)
	}
	for _, tc := range []struct {
		name   string
		change func(*observability.Report)
	}{
		{"restart", func(r *observability.Report) { r.Metrics.CounterEpoch = "reboot" }},
		{"missing sequence", func(r *observability.Report) { r.Sequence++ }},
		{"interval gap", func(r *observability.Report) { r.ObservedAt = r.ObservedAt.Add(20 * time.Minute) }},
		{"interface reset", func(r *observability.Report) { r.Metrics.Interfaces[0].ReceiveBytes = 0 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			next := advance(r)
			tc.change(&next)
			next.Digest = observability.ReportDigest(next)
			broken, _, err := observability.Accept(s, next, next.ObservedAt)
			if err != nil {
				t.Fatal(err)
			}
			f := observability.ViewOf("node", broken, next.ObservedAt).Forecast
			if f.Status != "unavailable" || f.ExhaustedAt != nil {
				t.Fatal("forecast survived gap", f)
			}
		})
	}
	if f := observability.ViewOf("node", s, now.Add(16*time.Minute)).Forecast; f.Status != "unavailable" || f.Reason != "stale" {
		t.Fatal(f)
	}
	s.Config.Provider.NotificationSource = "provider_statement"
	if f := observability.ViewOf("node", s, now).Forecast; f.Reason != "continuous_usage_required" {
		t.Fatal(f)
	}
}
func TestForecastInsufficientZeroAndExpired(t *testing.T) {
	s, _, now := forecastFixture(t)
	s.Baseline.ObservedAt = now.Add(-time.Hour)
	if f := observability.ViewOf("node", s, now).Forecast; f.Reason != "less_than_24_hours" {
		t.Fatal(f)
	}
	s.Baseline.ObservedAt = now.Add(-24 * time.Hour)
	s.Baseline.NICBytesAtBaseline = s.ObservedNICBytes
	if f := observability.ViewOf("node", s, now).Forecast; f.Reason != "no_observed_usage" || f.ExhaustedAt != nil {
		t.Fatal(f)
	}
	end := now.Add(-time.Second)
	s.Config.Provider.ExpiresAt = &end
	if f := observability.ViewOf("node", s, now).Forecast; f.Reason != "service_expired" {
		t.Fatal(f)
	}
}
