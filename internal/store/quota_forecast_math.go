package store

import (
	"math/big"
	"strconv"
	"time"
)

// QuotaForecast is advisory. RemainingBytes is the settled overview balance;
// reservations are subtracted only for this conservative projection, not billing.
type QuotaForecast struct {
	Available             bool       `json:"available"`
	Reason                string     `json:"reason"`
	AsOf                  time.Time  `json:"asOf"`
	WindowStart           time.Time  `json:"windowStart"`
	WindowEnd             time.Time  `json:"windowEnd"`
	RemainingBytes        string     `json:"remainingBytes"`
	ReservedBytes         string     `json:"reservedBytes"`
	Horizon               *time.Time `json:"horizon,omitempty"`
	EstimatedExhaustionAt *time.Time `json:"estimatedExhaustionAt,omitempty"`
	EnoughUntilHorizon    *bool      `json:"enoughUntilHorizon,omitempty"`
}

type quotaForecastInput struct {
	WindowComplete              bool
	SealedUsageWeighted         uint64
	WindowStart, WindowEnd, Now time.Time
	Remaining, Reserved         int64
	NextReset, ServiceExpiry    *time.Time
}

const quotaForecastWindow = 7 * 24 * time.Hour
const quotaForecastMaxHorizon = 366 * 24 * time.Hour

// buildQuotaForecast never changes state. Integer arithmetic preserves weighted
// byte precision above JavaScript's safe range and prevents intermediate overflow.
// Its caller must prove coverage and pass the same atomic quota/policy snapshot
// used for the overview. A sealed window is evidence, not a promise of future use.
func buildQuotaForecast(in quotaForecastInput) QuotaForecast {
	f := QuotaForecast{Reason: "incomplete_window", AsOf: in.Now, WindowStart: in.WindowStart, WindowEnd: in.WindowEnd, RemainingBytes: strconv.FormatInt(in.Remaining, 10), ReservedBytes: strconv.FormatInt(in.Reserved, 10)}
	validTime := func(t time.Time) bool { return !t.IsZero() && t.Year() >= 1 && t.Year() <= 9999 }
	// Keep unavailable responses JSON-safe even for invalid clock inputs.
	if !validTime(in.Now) {
		f.AsOf = time.Time{}
	}
	if !validTime(in.WindowStart) {
		f.WindowStart = time.Time{}
	}
	if !validTime(in.WindowEnd) {
		f.WindowEnd = time.Time{}
	}
	if !in.WindowComplete {
		return f
	}
	if !validTime(in.Now) || !validTime(in.WindowStart) || !validTime(in.WindowEnd) || !in.WindowStart.Add(quotaForecastWindow).Equal(in.WindowEnd) || in.WindowEnd.After(in.Now) {
		f.Reason = "invalid_window"
		return f
	}
	if in.Now.Sub(in.WindowEnd) > 24*time.Hour {
		f.Reason = "stale_window"
		return f
	}
	if in.Remaining < 0 || in.Reserved < 0 {
		f.Reason = "invalid_quota"
		return f
	}
	for _, at := range []*time.Time{in.NextReset, in.ServiceExpiry} {
		if at == nil {
			continue
		}
		if !validTime(*at) || !at.After(in.Now) {
			f.Reason = "expired_horizon"
			return f
		}
		if f.Horizon == nil || at.Before(*f.Horizon) {
			v := *at
			f.Horizon = &v
		}
	}
	if in.Reserved >= in.Remaining {
		f.Reason = "no_available_quota"
		return f
	}
	available := in.Remaining - in.Reserved // both nonnegative; subtraction cannot overflow
	boundedHorizon := f.Horizon != nil && !f.Horizon.After(in.Now.Add(quotaForecastMaxHorizon))
	if in.SealedUsageWeighted == 0 {
		if f.Horizon == nil {
			f.Reason = "no_observed_usage"
			return f
		}
		if !boundedHorizon {
			f.Reason = "estimate_out_of_range"
			return f
		}
		enough := true
		f.EnoughUntilHorizon = &enough
		f.Available = true
		f.Reason = "zero_usage_within_horizon"
		return f
	}
	// projected nanoseconds = available * exact window nanoseconds / weighted use.
	numerator := new(big.Int).Mul(big.NewInt(available), big.NewInt(int64(quotaForecastWindow)))
	denominator := new(big.Int).SetUint64(in.SealedUsageWeighted)
	if boundedHorizon {
		need := new(big.Int).Mul(denominator, big.NewInt(int64(f.Horizon.Sub(in.Now))))
		enough := numerator.Cmp(need) >= 0
		f.EnoughUntilHorizon = &enough
		if enough {
			f.Available = true
			f.Reason = "average_usage_within_horizon"
			return f
		}
	}
	duration := new(big.Int).Quo(numerator, denominator) // floor is conservative, never rounds exhaustion later
	if !duration.IsInt64() || duration.Sign() <= 0 || duration.Cmp(big.NewInt(int64(quotaForecastMaxHorizon))) > 0 {
		f.EnoughUntilHorizon = nil
		f.Reason = "estimate_out_of_range"
		return f
	}
	at := in.Now.Add(time.Duration(duration.Int64()))
	if !validTime(at) || !at.After(in.Now) {
		f.EnoughUntilHorizon = nil
		f.Reason = "estimate_out_of_range"
		return f
	}
	if f.Horizon != nil {
		enough := false
		f.EnoughUntilHorizon = &enough
	}
	f.Available = true
	f.Reason = "constant_rate_estimate"
	f.EstimatedExhaustionAt = &at
	return f
}
