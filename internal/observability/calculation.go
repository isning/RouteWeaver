package observability

import (
	"errors"
	"math"
	"reflect"
	"time"
)

func Accept(s State, r Report, now time.Time) (State, Receipt, error) {
	receipt := Receipt{StreamEpoch: r.StreamEpoch, Sequence: r.Sequence, Digest: r.Digest}
	if e := ValidateReport(r, now); e != nil {
		return s, receipt, e
	}
	if s.Config.ObserverInstanceID == "" || s.Config.ObserverInstanceID != r.Scope.InstanceID {
		return s, receipt, ErrScope
	}
	if s.Latest != nil {
		prev := s.Latest.Report
		if prev.Scope.NodeID != r.Scope.NodeID {
			return s, receipt, ErrScope
		}
		if prev.Scope == r.Scope && prev.StreamEpoch == r.StreamEpoch && prev.Sequence == r.Sequence {
			if prev.Digest != r.Digest {
				return s, receipt, conflict("sequence reused with different payload")
			}
			receipt.Duplicate = true
			return s, receipt, nil
		}
		if !r.ObservedAt.After(prev.ObservedAt) {
			return s, receipt, conflict("out-of-order observation time")
		}
		if prev.Scope == r.Scope && prev.StreamEpoch == r.StreamEpoch && r.Sequence <= prev.Sequence {
			return s, receipt, conflict("out-of-order sequence")
		}
		if (prev.Scope != r.Scope || prev.StreamEpoch != r.StreamEpoch) && r.Sequence != 1 {
			return s, receipt, conflict("new observer stream must begin at sequence one")
		}
	} else if r.Sequence != 1 {
		return s, receipt, conflict("initial observer stream must begin at sequence one")
	}
	snap := Snapshot{Report: r, ReceivedAt: now, Continuity: "initial", Source: "linux_procfs"}
	reason := "initial_observation_requires_baseline"
	var rx, tx int64
	if s.Latest != nil {
		prev := s.Latest.Report
		switch {
		case prev.Scope != r.Scope || prev.StreamEpoch != r.StreamEpoch:
			reason = "observer_stream_changed"
			snap.Continuity = "stream_reset"
		case r.Sequence != prev.Sequence+1:
			reason = "observation_sequence_gap"
			snap.Continuity = "sequence_gap"
		case prev.Metrics.CounterEpoch != r.Metrics.CounterEpoch:
			reason = "node_restarted"
			snap.Continuity = "counter_reset"
		case r.ObservedAt.Sub(prev.ObservedAt) > FreshFor:
			reason = "observation_interval_gap"
			snap.Continuity = "time_gap"
		default:
			snap.Continuity = "continuous"
			a, b := prev.Metrics, r.Metrics
			if b.CPUTotalTicks > a.CPUTotalTicks && b.CPUIdleTicks >= a.CPUIdleTicks && b.CPUIdleTicks-a.CPUIdleTicks <= b.CPUTotalTicks-a.CPUTotalTicks {
				percent := 100 * (1 - float64(b.CPUIdleTicks-a.CPUIdleTicks)/float64(b.CPUTotalTicks-a.CPUTotalTicks))
				snap.CPUPercent = &percent
			}
			var e error
			rx, tx, e = nicDelta(prev, r, s.Config.BilledInterfaces)
			if e != nil {
				reason = e.Error()
				snap.Continuity = "interface_gap"
			} else if len(s.Config.BilledInterfaces) == 0 {
				reason = "billed_interfaces_not_selected"
			} else if !currentCycle(s.Config.Provider, prev.ObservedAt) || !currentCycle(s.Config.Provider, r.ObservedAt) {
				reason = "cycle_boundary_requires_reconciliation"
			} else {
				delta, e := Add(rx, tx)
				if e != nil {
					return s, receipt, e
				}
				total, e := Add(s.ObservedNICBytes, delta)
				if e != nil {
					return s, receipt, e
				}
				s.ObservedNICBytes = total
				if s.ObservedSince == nil {
					at := prev.ObservedAt
					s.ObservedSince = &at
				}
				reason = ""
			}
			if e == nil && len(s.Config.BilledInterfaces) > 0 {
				seconds := r.ObservedAt.Sub(prev.ObservedAt).Seconds()
				receive, transmit := float64(rx)/seconds, float64(tx)/seconds
				snap.ReceiveBytesPerSecond = &receive
				snap.TransmitBytesPerSecond = &transmit
			}
		}
	}
	if s.ObservedSince == nil {
		at := r.ObservedAt
		s.ObservedSince = &at
	}
	if reason != "" {
		s.CoverageReason = reason
		s.Baseline = nil
	}
	s.Latest = &snap
	return s, receipt, nil
}
func nicDelta(prev, next Report, selected []string) (int64, int64, error) {
	old, current := map[string]Interface{}, map[string]Interface{}
	for _, i := range prev.Metrics.Interfaces {
		old[i.Name] = i
	}
	for _, i := range next.Metrics.Interfaces {
		current[i.Name] = i
	}
	var rx, tx int64
	for _, name := range selected {
		a, ok := old[name]
		b, exists := current[name]
		if !ok || !exists {
			return 0, 0, errors.New("selected_interface_missing")
		}
		if b.ReceiveBytes < a.ReceiveBytes || b.TransmitBytes < a.TransmitBytes {
			return 0, 0, errors.New("selected_interface_counter_reset")
		}
		dr, dt := b.ReceiveBytes-a.ReceiveBytes, b.TransmitBytes-a.TransmitBytes
		if dr > math.MaxInt64 || dt > math.MaxInt64 {
			return 0, 0, errors.New("interface_counter_overflow")
		}
		var e error
		rx, e = Add(rx, int64(dr))
		if e != nil {
			return 0, 0, e
		}
		tx, e = Add(tx, int64(dt))
		if e != nil {
			return 0, 0, e
		}
	}
	return rx, tx, nil
}
func Configure(s State, c Config) (State, error) {
	if e := ValidateConfig(c); e != nil {
		return s, e
	}
	if c.Revision != s.Config.Revision {
		return s, conflict("configuration revision changed; reload before saving")
	}
	reset := c.ObserverInstanceID != s.Config.ObserverInstanceID || !reflect.DeepEqual(c.BilledInterfaces, s.Config.BilledInterfaces)
	cycleChanged := (s.Config.Provider == nil) != (c.Provider == nil)
	if c.Provider != nil && s.Config.Provider != nil {
		a, b := c.Provider, s.Config.Provider
		cycleChanged = a.CycleID != b.CycleID || !a.CycleStart.Equal(b.CycleStart) || !a.CycleEnd.Equal(b.CycleEnd)
	}
	if reset || cycleChanged {
		s.Baseline = nil
		s.ObservedNICBytes = 0
		s.ObservedSince = nil
		s.CoverageReason = "configuration_changed_requires_baseline"
	}
	if c.ObserverInstanceID != s.Config.ObserverInstanceID {
		s.Latest = nil
	}
	if cycleChanged {
		s.Statement = nil
	}
	if s.Config.Revision == math.MaxUint64 {
		return s, errors.New("configuration revision exhausted")
	}
	c.Revision++
	s.Config = c
	return s, nil
}
func Reconcile(s State, in BaselineInput, actor string, now time.Time) (State, error) {
	if s.Config.Provider == nil || in.CycleID != s.Config.Provider.CycleID || in.UsedBytes < 0 || !text(in.Reason, 1000) || !text(actor, 128) {
		return s, errors.New("current cycle, nonnegative used bytes and reconciliation reason required")
	}
	if s.Latest == nil || in.ReportDigest != s.Latest.Digest || !fresh(s.Latest.ObservedAt, now) || !currentCycle(s.Config.Provider, s.Latest.ObservedAt) || !currentCycle(s.Config.Provider, now) {
		return s, conflict("baseline requires the latest fresh report in the configured current cycle")
	}
	if len(s.Config.BilledInterfaces) == 0 {
		return s, errors.New("explicit billed interfaces required for a NIC baseline")
	}
	if _, _, e := nicDelta(s.Latest.Report, s.Latest.Report, s.Config.BilledInterfaces); e != nil {
		return s, e
	}
	s.Baseline = &Baseline{BaselineInput: in, ObservedAt: s.Latest.ObservedAt, RecordedAt: now, ActorID: actor, NICBytesAtBaseline: s.ObservedNICBytes}
	s.CoverageReason = "operator_reconciled_nic_estimate"
	return s, nil
}
func RecordStatement(s State, in StatementInput, actor string, now time.Time) (State, error) {
	if s.Config.Provider == nil || in.CycleID != s.Config.Provider.CycleID || in.UsedBytes < 0 || !text(in.Reference, 500) || !text(actor, 128) || in.ObservedAt.IsZero() || in.ObservedAt.After(now.Add(time.Minute)) || !currentCycle(s.Config.Provider, in.ObservedAt) {
		return s, errors.New("provider statement requires matching cycle, valid observed time, nonnegative used bytes and source reference")
	}
	if s.Statement != nil && !in.ObservedAt.After(s.Statement.ObservedAt) {
		return s, conflict("provider statement must be newer than the recorded statement")
	}
	s.Statement = &Statement{StatementInput: in, RecordedAt: now, ActorID: actor}
	return s, nil
}
func ViewOf(id string, s State, now time.Time) View {
	p := ProviderView{Source: "none", Coverage: "unobserved", StatusReason: "provider_not_configured", ObservedSince: s.ObservedSince, ObservedNICBytes: s.ObservedNICBytes, ExhaustionAction: "advisory"}
	result := View{NodeID: id, Config: s.Config, Latest: s.Latest, Baseline: s.Baseline, Statement: s.Statement}
	c := s.Config.Provider
	if e := ValidateConfig(s.Config); e != nil {
		p.StatusReason = "invalid_provider_configuration"
		if c != nil && c.ExhaustionAction != "advisory" {
			p.ManagedAdmissionReason = "provider-usage-unknown"
		}
		result.Provider = p
		result.Forecast = ForecastOf(s, result.Provider, now)
		return result
	}
	if c == nil {
		result.Provider = p
		result.Forecast = ForecastOf(s, result.Provider, now)
		return result
	}
	if c.Mode == "limited" {
		total, _ := TotalBytes(*c)
		p.TotalBytes = &total
	}
	p.ExhaustionAction = c.ExhaustionAction
	p.Source = c.NotificationSource
	if p.Source == "none" {
		if s.Statement != nil {
			p.Source = "provider_statement"
		} else {
			p.Source = "nic_estimate"
		}
	}
	p.StatusReason = s.CoverageReason
	if p.Source == "provider_statement" && s.Statement != nil && s.Statement.CycleID == c.CycleID {
		p.Coverage = "provider_statement"
		p.StatusReason = "operator_entered_provider_statement"
		used := s.Statement.UsedBytes
		p.UsedBytes = &used
		at := s.Statement.ObservedAt
		p.ObservedAt = &at
	} else if p.Source == "nic_estimate" {
		if s.Latest != nil {
			at := s.Latest.ObservedAt
			p.ObservedAt = &at
			p.Coverage = "partial"
		}
		if s.Baseline != nil && s.Baseline.CycleID == c.CycleID {
			used, e := Add(s.Baseline.UsedBytes, s.ObservedNICBytes-s.Baseline.NICBytesAtBaseline)
			if e == nil {
				p.UsedBytes = &used
				p.Coverage = "reconciled_estimate"
				p.StatusReason = "operator_reconciled_nic_estimate"
			}
		}
	} else {
		p.StatusReason = "provider_statement_required"
	}
	if p.ObservedAt != nil {
		p.Fresh = fresh(*p.ObservedAt, now)
	}
	if !currentCycle(c, now) {
		p.StatusReason = "configured_cycle_not_current"
		p.Fresh = false
	}
	if p.UsedBytes != nil && p.TotalBytes != nil {
		remaining := *p.TotalBytes - *p.UsedBytes
		if remaining < 0 {
			remaining = 0
		}
		p.RemainingBytes = &remaining
	}
	p.NotificationEligible = c.NotificationSource != "none" && p.Source == c.NotificationSource && p.Fresh && p.RemainingBytes != nil && (p.Coverage == "provider_statement" || p.Coverage == "reconciled_estimate")
	if c.Mode == "unlimited" {
		p.StatusReason = "operator_configured_unlimited"
		p.NotificationEligible = false
	}
	p.ManagedAdmissionReason, _ = managedAdmissionView(c, p, now)
	result.Provider = p
	result.Forecast = ForecastOf(s, result.Provider, now)
	return result
}
