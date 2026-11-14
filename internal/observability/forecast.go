package observability

import "time"

// Forecast is an advisory constant-rate projection, never an admission decision.
// It reuses the reconciled continuous NIC ledger; sparse chart samples are not
// integrated and no additional observations, history records or writes are made.
type Forecast struct {
	Status                string     `json:"status"`
	Reason                string     `json:"reason"`
	BasisStart            *time.Time `json:"basisStart,omitempty"`
	BasisEnd              *time.Time `json:"basisEnd,omitempty"`
	AverageBytesPerSecond *float64   `json:"averageBytesPerSecond,omitempty"`
	ExhaustedAt           *time.Time `json:"exhaustedAt,omitempty"`
	Horizon               *time.Time `json:"horizon,omitempty"`
}

func ForecastOf(s State, p ProviderView, now time.Time) Forecast {
	f := Forecast{Status: "unavailable", Reason: "provider_not_configured"}
	c := s.Config.Provider
	if c == nil {
		return f
	}
	if ValidateConfig(s.Config) != nil {
		f.Reason = "invalid_configuration"
		return f
	}
	if c.Mode == "unlimited" {
		f.Reason = "unlimited"
		return f
	}
	if !currentCycle(c, now) {
		f.Reason = "cycle_not_current"
		return f
	}
	if c.ExpiresAt != nil && !now.Before(*c.ExpiresAt) {
		f.Reason = "service_expired"
		return f
	}
	if p.Source != "nic_estimate" {
		f.Reason = "continuous_usage_required"
		return f
	}
	if s.Baseline == nil || p.Coverage != "reconciled_estimate" || s.Baseline.CycleID != c.CycleID || p.RemainingBytes == nil {
		f.Reason = "reconciliation_required"
		return f
	}
	if s.Latest == nil || !p.Fresh || !fresh(s.Latest.ObservedAt, now) || s.Latest.ObservedAt.After(now) {
		f.Reason = "stale"
		return f
	}
	if *p.RemainingBytes == 0 {
		f.Status = "exhausted"
		f.Reason = "recorded_balance_exhausted"
		return f
	}
	start, end := s.Baseline.ObservedAt, s.Latest.ObservedAt
	f.BasisStart = &start
	f.BasisEnd = &end
	if start.Before(c.CycleStart) || !end.After(start) || s.ObservedNICBytes < s.Baseline.NICBytesAtBaseline || s.Baseline.NICBytesAtBaseline < 0 || s.Baseline.UsedBytes < 0 {
		f.Reason = "invalid_basis"
		return f
	}
	if end.Sub(start) < 24*time.Hour {
		f.Reason = "less_than_24_hours"
		return f
	}
	delta := s.ObservedNICBytes - s.Baseline.NICBytesAtBaseline
	average := float64(delta) / end.Sub(start).Seconds()
	f.AverageBytesPerSecond = &average
	horizon := c.CycleEnd
	if c.ExpiresAt != nil && c.ExpiresAt.Before(horizon) {
		horizon = *c.ExpiresAt
	}
	f.Horizon = &horizon
	if delta == 0 {
		f.Reason = "no_observed_usage"
		return f
	}
	seconds := float64(*p.RemainingBytes) / average
	if seconds >= horizon.Sub(end).Seconds() {
		f.Status = "beyond_horizon"
		f.Reason = "constant_rate_within_current_period"
		return f
	}
	at := end.Add(time.Duration(seconds * float64(time.Second)))
	if !at.After(now) {
		f.Reason = "projection_already_elapsed"
		return f
	}
	f.Status = "estimated"
	f.Reason = "constant_rate_from_reconciliation"
	f.ExhaustedAt = &at
	return f
}
