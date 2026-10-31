// Package service contains control-plane business policy, independent of transport and storage.
package service

import (
	"fmt"
	"math/big"
	"time"
)

const RateScale int64 = 1_000_000

var DefaultLocation = time.FixedZone("UTC+8", 8*60*60)

type CyclePolicy struct {
	Mode     string    `json:"mode"` // monthly, anniversary, fixed-days, none
	Day      int       `json:"day,omitempty"`
	Days     int       `json:"days,omitempty"`
	Anchor   time.Time `json:"anchor"`
	Timezone string    `json:"timezone"`
}
type Plan struct {
	ID              string      `json:"id"`
	Name            string      `json:"name"`
	QuotaBytes      int64       `json:"quotaBytes"`
	RouteIDs        []string    `json:"routeIds"`
	Cycle           CyclePolicy `json:"cycle"`
	OnlineIPLimit   int         `json:"onlineIpLimit"`
	ConnectionLimit int         `json:"connectionLimit"`
	EntryRateBPS    int64       `json:"entryRateBps"`
}
type Entitlement struct {
	UserID                  string      `json:"userId"`
	ServiceID               string      `json:"serviceId,omitempty"`
	StartsAt                time.Time   `json:"startsAt"`
	ExpiresAt               *time.Time  `json:"expiresAt,omitempty"`
	Cycle                   CyclePolicy `json:"cycle"`
	QuotaOverride           *int64      `json:"quotaOverride,omitempty"`
	Paused                  bool        `json:"paused"`
	RouteIDsOverride        *[]string   `json:"routeIdsOverride,omitempty"`
	OnlineIPLimitOverride   *int        `json:"onlineIpLimitOverride,omitempty"`
	ConnectionLimitOverride *int        `json:"connectionLimitOverride,omitempty"`
	EntryRateBPSOverride    *int64      `json:"entryRateBpsOverride,omitempty"`
}
type CycleWindow struct {
	Start     time.Time  `json:"start"`
	NextReset *time.Time `json:"nextReset"`
	Timezone  string     `json:"timezone"`
}
type UsageTotals struct {
	RawBytes      int64 `json:"rawBytes"`
	WeightedBytes int64 `json:"weightedBytes"`
	ProviderBytes int64 `json:"providerBytes"`
}
type Rate struct {
	ID          string    `json:"id"`
	RouteID     string    `json:"routeId"`
	Micros      int64     `json:"micros"`
	EffectiveAt time.Time `json:"effectiveAt"`
}

func (p CyclePolicy) Validate() error {
	if p.Timezone != "" && p.Timezone != "UTC+8" && p.Timezone != "Asia/Shanghai" {
		return fmt.Errorf("cycle timezone must be UTC+8")
	}
	switch p.Mode {
	case "none":
		return nil
	case "monthly":
		if p.Day < 1 || p.Day > 31 {
			return fmt.Errorf("monthly day must be 1–31")
		}
	case "anniversary":
	case "fixed-days":
		if p.Days < 1 || p.Days > 3660 {
			return fmt.Errorf("fixed days must be 1–3660")
		}
	default:
		return fmt.Errorf("unknown cycle mode")
	}
	if p.Anchor.IsZero() {
		return fmt.Errorf("cycle anchor required")
	}
	return nil
}
func monthDay(y int, m time.Month, day int) time.Time {
	last := time.Date(y, m+1, 0, 0, 0, 0, 0, DefaultLocation).Day()
	if day > last {
		day = last
	}
	return time.Date(y, m, day, 0, 0, 0, 0, DefaultLocation)
}

// Window uses the original day in every month, not a previously clamped date.
func (p CyclePolicy) Window(now time.Time) (CycleWindow, error) {
	if err := p.Validate(); err != nil {
		return CycleWindow{}, err
	}
	now = now.In(DefaultLocation)
	a := p.Anchor.In(DefaultLocation)
	w := CycleWindow{Start: a, Timezone: "UTC+8"}
	if p.Mode == "none" {
		return w, nil
	}
	if now.Before(a) {
		w.NextReset = &a
		return w, nil
	}
	if p.Mode == "fixed-days" {
		d := time.Duration(p.Days) * 24 * time.Hour
		n := now.Sub(a) / d
		w.Start = a.Add(n * d)
		next := w.Start.Add(d)
		w.NextReset = &next
		return w, nil
	}
	day := p.Day
	if p.Mode == "anniversary" {
		day = a.Day()
	}
	start := monthDay(now.Year(), now.Month(), day)
	if start.After(now) {
		start = monthDay(now.Year(), now.Month()-1, day)
	}
	next := monthDay(start.Year(), start.Month()+1, day)
	if start.Before(a) {
		start = a
	}
	w.Start = start
	w.NextReset = &next
	return w, nil
}
func WeightedBytes(raw, micros int64) (int64, error) {
	if raw < 0 || micros < 0 || micros > 1000*RateScale {
		return 0, fmt.Errorf("invalid amount or rate")
	}
	z := new(big.Int).Mul(big.NewInt(raw), big.NewInt(micros))
	z.Add(z, big.NewInt(RateScale-1))
	z.Div(z, big.NewInt(RateScale))
	if !z.IsInt64() {
		return 0, fmt.Errorf("weighted usage overflow")
	}
	return z.Int64(), nil
}
