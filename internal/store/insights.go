package store

import (
	"context"
	"database/sql"
	"errors"
	"math/big"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/service"
	"sort"
	"time"
)

// Insights is an observation, not an admission decision. It never attributes
// shared account/route accounting to a subscription or interpolates intervals.
const insightsRowLimit = 10000
const insightsRecordBytes = 65536

var ErrInsightsUnavailable = errors.New("usage insights temporarily unavailable")

type InsightUsage struct {
	RawBytes      int64 `json:"rawBytes"`
	WeightedBytes int64 `json:"weightedBytes"`
}
type InsightDay struct {
	Date string `json:"date"`
	InsightUsage
}
type InsightRoute struct {
	RouteID string `json:"routeId"`
	InsightUsage
}
type InsightAdmission struct {
	Available       bool      `json:"available"`
	AsOf            time.Time `json:"asOf"`
	MaxLeaseSeconds int       `json:"maxLeaseSeconds"`
	OnlineIPs       []string  `json:"onlineIps"`
	ActiveStreams   int       `json:"activeStreams"`
}
type UsageInsights struct {
	AsOf      time.Time        `json:"asOf"`
	Timezone  string           `json:"timezone"`
	Daily     []InsightDay     `json:"daily"`
	Routes    []InsightRoute   `json:"routes"`
	Admission InsightAdmission `json:"admission"`
}
type insightSum struct{ raw, weighted big.Int }

func (s *insightSum) add(r MeterRecord) {
	s.raw.Add(&s.raw, big.NewInt(r.RawBytes))
	s.weighted.Add(&s.weighted, new(big.Int).Mul(big.NewInt(r.RawBytes), big.NewInt(r.RateMicros)))
}
func (s *insightSum) value() (InsightUsage, error) {
	// Round once per bucket, matching the canonical usage reducer. Bucket sums
	// can differ by rounding bytes from an all-period aggregate.
	n := new(big.Int).Add(&s.weighted, big.NewInt(service.RateScale-1))
	n.Div(n, big.NewInt(service.RateScale))
	if !s.raw.IsInt64() || !n.IsInt64() {
		return InsightUsage{}, ErrInsightsUnavailable
	}
	return InsightUsage{s.raw.Int64(), n.Int64()}, nil
}

func (s *Store) UsageInsightsContext(ctx context.Context, user string, cycleStart, now time.Time) (UsageInsights, error) {
	return s.usageInsightsContext(ctx, user, cycleStart, now, nil)
}
func (s *Store) UserInsightsContext(ctx context.Context, user string, now time.Time) (UsageInsights, service.EffectivePolicy, service.CycleWindow, error) {
	var policy service.EffectivePolicy
	var cycle service.CycleWindow
	usage, err := s.usageInsightsContext(ctx, user, time.Time{}, now, func(tx *sql.Tx) (time.Time, error) {
		var e error
		policy, cycle, e = s.insightsPolicyTx(ctx, tx, user, now)
		return cycle.Start, e
	})
	return usage, policy, cycle, err
}
func (s *Store) usageInsightsContext(ctx context.Context, user string, cycleStart, now time.Time, prepare func(*sql.Tx) (time.Time, error)) (UsageInsights, error) {
	out := UsageInsights{AsOf: now, Timezone: "UTC+8", Daily: []InsightDay{}, Routes: []InsightRoute{}, Admission: InsightAdmission{AsOf: now, MaxLeaseSeconds: int(entrypolicy.MaxLease / time.Second), OnlineIPs: []string{}}}
	local := now.In(service.DefaultLocation)
	start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, service.DefaultLocation).AddDate(0, 0, -13)
	days := make([]insightSum, 14)
	routes := map[string]*insightSum{}
	err := s.readSnapshot(ctx, func(tx *sql.Tx) error {
		if prepare != nil {
			var e error
			cycleStart, e = prepare(tx)
			if e != nil {
				return e
			}
		}
		windowStart := start
		if cycleStart.Before(windowStart) {
			windowStart = cycleStart
		}
		if e := s.visitInsightLedgerWindowTx(ctx, tx, user, windowStart, now, func(record MeterRecord) error {
			if !record.ObservedAt.Before(start) {
				i := int(record.ObservedAt.In(service.DefaultLocation).Sub(start) / (24 * time.Hour))
				if i >= 0 && i < 14 {
					days[i].add(record)
				}
			}
			if !record.ObservedAt.Before(cycleStart) {
				if routes[record.RouteID] == nil {
					routes[record.RouteID] = &insightSum{}
				}
				routes[record.RouteID].add(record)
			}
			return nil
		}); e != nil {
			return e
		}
		admission, e := s.insightAdmissionTx(ctx, tx, user, now)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if e == nil {
			out.Admission = admission
		}
		// Lease observation failure is explicitly unavailable, never a false
		// zero. Complete ledger buckets remain independently useful.

		return nil
	})
	if err != nil {
		return UsageInsights{}, err
	}
	for i := range days {
		v, e := days[i].value()
		if e != nil {
			return UsageInsights{}, e
		}
		out.Daily = append(out.Daily, InsightDay{start.AddDate(0, 0, i).Format("2006-01-02"), v})
	}
	ids := []string{}
	for id := range routes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		v, e := routes[id].value()
		if e != nil {
			return UsageInsights{}, e
		}
		out.Routes = append(out.Routes, InsightRoute{id, v})
	}
	return out, nil
}

// InsightsPolicyContext reuses the authoritative policy evaluator in a bounded
// read snapshot rather than calling the writer-locked, unbounded list helpers.
func (s *Store) insightsPolicyTx(ctx context.Context, tx *sql.Tx, user string, now time.Time) (service.EffectivePolicy, service.CycleWindow, error) {
	var policy service.EffectivePolicy
	var cycle service.CycleWindow
	err := func() error {
		// Preflight exactly the collections effectivePolicyTx reads, in the same
		// snapshot. Limit is shared, so neither record count nor ciphertext can grow
		// unbounded between the check and the evaluator.
		count, size := 0, 0
		for _, kind := range []string{"users", "accounts", "entitlements", "services", "user-groups", "routes", "resets"} {
			query := `SELECT length(data) FROM records WHERE kind=?`
			args := []any{kind}
			if kind == "users" || kind == "accounts" || kind == "entitlements" {
				query += ` AND id=?`
				args = append(args, user)
			}
			query += ` LIMIT ?`
			args = append(args, insightsRowLimit+1)
			rows, e := tx.QueryContext(ctx, query, args...)
			if e != nil {
				return e
			}
			for rows.Next() {
				var n int
				if e = rows.Scan(&n); e != nil {
					rows.Close()
					return e
				}
				count++
				size += n
				if count > insightsRowLimit || n > insightsRecordBytes || size > 8*1024*1024 {
					rows.Close()
					return ErrInsightsUnavailable
				}
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return e
			}
		}
		var e error
		policy, e = s.effectivePolicyTx(tx, user, now)
		if e != nil {
			return e
		}
		cycle, e = policy.Entitlement.Cycle.Window(now)
		if e != nil {
			return e
		}
		rows, e := tx.QueryContext(ctx, `SELECT id,data FROM records WHERE kind='resets' LIMIT ?`, insightsRowLimit+1)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			if e = ctx.Err(); e != nil {
				return e
			}
			var id string
			var raw []byte
			var reset Reset
			if e = rows.Scan(&id, &raw); e != nil {
				return e
			}
			if e = s.open("resets", id, raw, &reset); e != nil {
				return e
			}
			if reset.UserID == user && reset.At.After(cycle.Start) && !reset.At.After(now) {
				cycle.Start = reset.At
			}
		}
		return rows.Err()
	}()
	return policy, cycle, err
}

func (s *Store) insightAdmissionTx(ctx context.Context, tx *sql.Tx, user string, now time.Time) (InsightAdmission, error) {
	out := InsightAdmission{AsOf: now, MaxLeaseSeconds: int(entrypolicy.MaxLease / time.Second), OnlineIPs: []string{}}
	ips := map[string]bool{}
	add := func(lease admissionLease) {
		if lease.Binding.UserID == user && now.Before(lease.ExpiresAt) {
			ips[lease.ClientIP] = true
			out.ActiveStreams++
		}
	}
	finish := func() (InsightAdmission, error) {
		for ip := range ips {
			out.OnlineIPs = append(out.OnlineIPs, ip)
		}
		sort.Strings(out.OnlineIPs)
		out.Available = true
		return out, nil
	}
	// Only consume a complete authenticated hot projection, without invoking the
	// mutation/rebuild path. Missing or invalid hot state falls back boundedly.
	_, clean, e := s.admissionLiveGenerationTx(tx, leaseLive)
	if e != nil {
		return out, e
	}
	if clean {
		bounded := true
		for _, marker := range []bool{true, false} {
			account := user
			if marker {
				account = ""
			}
			token, _, err := s.admissionLiveKey(leaseLive, account, marker)
			if err != nil {
				return out, err
			}
			var n int
			err = tx.QueryRowContext(ctx, `SELECT length(data) FROM admission_lease_windows WHERE account=?`, token).Scan(&n)
			if err != nil && err != sql.ErrNoRows {
				return out, err
			}
			if n > 8*1024*1024 {
				bounded = false
			}
		}
		if bounded {
			marker, err := s.readAdmissionLiveRowTx(tx, leaseLive, "", true)
			if err != nil {
				return out, err
			}
			w, err := s.readAdmissionLiveRowTx(tx, leaseLive, user, false)
			if err != nil {
				return out, err
			}
			if marker != nil && !marker.Exceptional && w != nil && !now.Before(w.Watermark) {
				if len(w.Leases) > insightsRowLimit {
					return out, ErrInsightsUnavailable
				}
				for _, lease := range w.Leases {
					if err = ctx.Err(); err != nil {
						return out, err
					}
					add(lease)
				}
				return finish()
			}
		}
	}
	rows, e := tx.QueryContext(ctx, `SELECT id,CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind='entry-admission-leases' ORDER BY id LIMIT ?`, insightsRecordBytes, insightsRowLimit+1)
	if e != nil {
		return out, e
	}
	defer rows.Close()
	count, size := 0, 0
	for rows.Next() {
		if e = ctx.Err(); e != nil {
			return out, e
		}
		count++
		if count > insightsRowLimit {
			return out, ErrInsightsUnavailable
		}
		var id string
		var raw []byte
		var lease admissionLease
		if e = rows.Scan(&id, &raw); e != nil {
			return out, e
		}
		size += len(raw)
		if size > 8*1024*1024 {
			return out, ErrInsightsUnavailable
		}
		if e = s.open("entry-admission-leases", id, raw, &lease); e != nil {
			return out, ErrInsightsUnavailable
		}
		add(lease)
	}
	if e = rows.Err(); e != nil {
		return out, e
	}
	return finish()
}
