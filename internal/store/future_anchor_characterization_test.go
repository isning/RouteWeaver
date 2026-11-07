package store_test

import (
	"routeweaver/internal/service"
	"testing"
	"time"
)

// This diagnostic characterizes current behavior, not approved accounting
// policy or desired acceptance. In particular, the future-anchor ceiling of
// 120 is evidence of replenishment after an excluded 20-byte settlement, not
// permission to preserve that behavior in a fix. See
// docs/verification/BACKEND-RISKS-SOURCE-2026-11-06.md before changing semantics.
func TestCharacterizationFutureAnchorExcludesSettledUsageAndReplenishesBudget(t *testing.T) {
	for _, mode := range []string{"monthly", "anniversary", "fixed-days", "none"} {
		t.Run(mode, func(t *testing.T) {
			for _, tt := range []struct {
				name        string
				anchorDelta time.Duration
				wantCeiling uint64
				wantUsage   int64
			}{
				{name: "future-anchor", anchorDelta: time.Hour, wantCeiling: 120, wantUsage: 0},
				{name: "past-anchor-control", anchorDelta: -24 * time.Hour, wantCeiling: 100, wantUsage: 20},
			} {
				t.Run(tt.name, func(t *testing.T) {
					s, _, _, scope, fixtureNow := admissionFixture(t)
					// Keep the one-second settlement away from calendar boundaries.
					// The fixture enrollment remains valid at both supplied times.
					now := fixtureNow.Truncate(time.Minute)
					anchor := now.Add(tt.anchorDelta)
					quota := int64(100)
					ent := service.Entitlement{
						UserID: "account", ServiceID: "plan", StartsAt: now.Add(-48 * time.Hour), QuotaOverride: &quota,
						Cycle: service.CyclePolicy{Mode: mode, Day: anchor.In(service.DefaultLocation).Day(), Days: 7, Anchor: anchor, Timezone: "UTC+8"},
					}
					// Exercise the reviewed write path before any budget exists.
					change := service.PolicyChange{Entitlement: &ent}
					preview, err := s.PreviewPolicyChange(change, now)
					if err != nil || len(preview.Blockers) != 0 || len(preview.Affected) != 1 {
						t.Fatalf("policy preview: %+v, error %v", preview, err)
					}
					if _, err := s.ApplyPolicyChange(change, preview.Revision, now); err != nil {
						t.Fatal(err)
					}
					if err := s.SetRate(service.Rate{ID: "characterization-1x", RouteID: "route", Micros: service.RateScale, EffectiveAt: now.Add(-time.Hour)}); err != nil {
						t.Fatal(err)
					}
					policy, err := s.EffectivePolicy("account", now)
					if err != nil || policy.Status != "active" || policy.QuotaBytes != 100 || !policy.Entitlement.Cycle.Anchor.Equal(anchor) {
						t.Fatalf("saved active policy: %+v, error %v", policy, err)
					}
					in := admissionRequest("entry1", "192.0.2.1", "future-anchor-characterization")
					first, err := s.AcquireAdmission(scope, in, now)
					if err != nil || !first.Allowed || first.ByteBudget == nil || *first.ByteBudget != 100 {
						t.Fatalf("initial 100-byte grant: %+v, error %v", first, err)
					}
					settledAt := now.Add(time.Second)
					in.AdmittedBytes = 20
					renewed, err := s.AcquireAdmission(scope, in, settledAt)
					if err != nil || !renewed.Allowed || renewed.LeaseID != first.LeaseID || renewed.ByteBudget == nil || *renewed.ByteBudget != tt.wantCeiling {
						t.Fatalf("current-behavior cumulative ceiling, want %d: %+v, error %v", tt.wantCeiling, renewed, err)
					}
					ledger, err := s.Usage("account", time.Time{}, time.Time{})
					if err != nil || ledger.RawBytes != 20 || ledger.WeightedBytes != 20 {
						t.Fatalf("all-time settled usage, want 20 raw and weighted: %+v, error %v", ledger, err)
					}
					window, err := policy.Entitlement.Cycle.Window(settledAt)
					if err != nil {
						t.Fatal(err)
					}
					if window.Start.After(settledAt) != (tt.anchorDelta > 0) {
						t.Fatalf("unexpected cycle start relative to settlement: %+v at %v", window, settledAt)
					}
					if mode == "none" {
						if window.NextReset != nil {
							t.Fatalf("non-resetting cycle gained a reset: %+v", window)
						}
					} else if tt.anchorDelta > 0 && (window.NextReset == nil || !window.NextReset.Equal(anchor)) {
						t.Fatalf("future resetting cycle boundary differs from anchor: %+v", window)
					}
					// Match the overview's as-of read through exported store seams;
					// this is not a test of the HTTP overview endpoint itself.
					start, err := s.LastReset("account", window.Start, settledAt)
					if err != nil {
						t.Fatal(err)
					}
					usage, err := s.Usage("account", start, settledAt.Add(time.Nanosecond))
					if err != nil || usage.RawBytes != tt.wantUsage || usage.WeightedBytes != tt.wantUsage {
						t.Fatalf("as-of cycle usage, want %d raw and weighted: %+v, error %v", tt.wantUsage, usage, err)
					}
				})
			}
		})
	}
}
