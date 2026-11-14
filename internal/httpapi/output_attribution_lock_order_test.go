package httpapi

import (
	"reflect"
	"testing"
)

// Exhaustively interleave the two cancellation workers' acquisition steps.
// This models the production rule that all acquired deployment locks remain
// owned until every deployment is compensated. Native mutation/receipt behavior
// is covered separately; this test specifically guards cross-deployment ordering.
func TestIndependentCancellationSharedDeploymentLockOrdering(t *testing.T) {
	for attempt := 0; attempt < 100; attempt++ {
		a := orderedAttributionDeployments(map[string]string{"deployment-z": "a-first-receipt", "deployment-a": "a-second-receipt"})
		b := orderedAttributionDeployments(map[string]string{"deployment-a": "b-last-receipt", "deployment-z": "b-first-receipt"})
		if !reflect.DeepEqual(a, []string{"deployment-a", "deployment-z"}) || !reflect.DeepEqual(a, b) {
			t.Fatalf("inconsistent deployment order: %v %v", a, b)
		}
		orders := [2][]string{a, b}
		var walk func([2]int, map[string]int)
		walk = func(next [2]int, locks map[string]int) {
			if next[0] == 3 && next[1] == 3 {
				return
			}
			moved := false
			for worker := 0; worker < 2; worker++ {
				n := next[worker]
				if n == 3 {
					continue
				}
				if n < 2 {
					if owner, held := locks[orders[worker][n]]; held && owner != worker {
						continue
					}
				}
				moved = true
				copyLocks := map[string]int{}
				for dep, owner := range locks {
					copyLocks[dep] = owner
				}
				copyNext := next
				if n == 2 {
					for dep, owner := range copyLocks {
						if owner == worker {
							delete(copyLocks, dep)
						}
					}
				} else {
					copyLocks[orders[worker][n]] = worker
				}
				copyNext[worker]++
				walk(copyNext, copyLocks)
			}
			if !moved {
				t.Fatalf("deadlock at steps %v locks %v", next, locks)
			}
		}
		walk([2]int{}, map[string]int{})
	}
}
