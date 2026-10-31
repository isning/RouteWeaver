package store_test

import (
	"fmt"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// Enumerate every merge of two ordered acquire/consume+report/final lifecycles.
// This is bounded public-repository exploration, not an unbounded proof or a
// replacement for the real concurrent native payload tests.
func TestBoundedAdmissionLifecycleInterleavings(t *testing.T) {
	var traces [][]int
	var enumerate func([]int, int, int)
	enumerate = func(prefix []int, a, b int) {
		if a == 3 && b == 3 {
			traces = append(traces, append([]int{}, prefix...))
			return
		}
		if a < 3 {
			enumerate(append(append([]int{}, prefix...), 0), a+1, b)
		}
		if b < 3 {
			enumerate(append(append([]int{}, prefix...), 1), a, b+1)
		}
	}
	enumerate(nil, 0, 0)
	if len(traces) != 20 {
		t.Fatalf("enumeration incomplete: %d", len(traces))
	}
	for _, multiplier := range []int64{1, 2} {
		for _, staleClock := range []bool{false, true} {
			for n, trace := range traces {
				t.Run(fmt.Sprintf("rate%d/stale%t/trace%02d", multiplier, staleClock, n), func(t *testing.T) {
					s, path, key, scope, now := admissionFixture(t)
					second, err := store.Open(path, key)
					if err != nil {
						t.Fatal(err)
					}
					defer second.Close()
					finiteAdmissionPlan(t, s, 3*multiplier)
					if multiplier != 1 {
						if err := s.SetRate(service.Rate{ID: "model-rate", RouteID: "route", Micros: multiplier * service.RateScale, EffectiveAt: now.Add(-time.Minute)}); err != nil {
							t.Fatal(err)
						}
					}
					stores := []*store.Store{s, second}
					steps := [2]int{}
					ceilings := [2]int64{}
					consumed := [2]int64{}
					closed := [2]bool{}
					for tick, client := range trace {
						request := admissionRequest(fmt.Sprintf("entry%d", client+1), "192.0.2.1", fmt.Sprintf("model-presence-%d", client))
						step := steps[client]
						steps[client]++
						if step == 1 && consumed[client] < ceilings[client] && !closed[client] {
							consumed[client]++
						}
						request.AdmittedBytes = uint64(consumed[client])
						request.Final = step == 2
						offset := tick + 1
						if staleClock {
							offset = 6 - tick
						}
						reply, err := stores[client].AcquireAdmission(scope, request, now.Add(time.Duration(offset)*time.Millisecond))
						if err != nil {
							t.Fatalf("trace%v step%d: %v", trace, tick, err)
						}
						if reply.Allowed {
							if reply.ByteBudget == nil || *reply.ByteBudget < uint64(consumed[client]) || *reply.ByteBudget > 3 {
								t.Fatalf("invalid granted ceiling %+v", reply)
							}
							ceilings[client] = int64(*reply.ByteBudget)
						}
						if request.Final {
							closed[client] = true
						}
						var committedCeiling int64
						for i := range consumed {
							committedCeiling += consumed[i]
							if !closed[i] {
								committedCeiling += ceilings[i] - consumed[i]
							}
						}
						if committedCeiling*multiplier > 3*multiplier {
							t.Fatalf("overlapping allowance trace%v step%d: raw ceiling%d", trace, tick, committedCeiling)
						}
						usage, err := s.Usage("account", time.Time{}, time.Time{})
						if err != nil || usage.RawBytes != consumed[0]+consumed[1] || usage.WeightedBytes != (consumed[0]+consumed[1])*multiplier {
							t.Fatalf("settlement/replay invariant trace%v step%d: %+v %v", trace, tick, usage, err)
						}
						// Exact replay cannot create allowance or a second debit.
						if _, err := stores[client].AcquireAdmission(scope, request, now.Add(time.Duration(offset)*time.Millisecond)); err != nil {
							t.Fatal(err)
						}
						replay, _ := s.Usage("account", time.Time{}, time.Time{})
						if replay.RawBytes != usage.RawBytes || replay.WeightedBytes != usage.WeightedBytes {
							t.Fatal("replay charged twice")
						}
					}
				})
			}
		}
	}
}
