package store

import "testing"

// Infrastructure seam: generic canonical writes must dirty only their domain.
func TestAdmissionLiveStateIndependentDirtyDomains(t *testing.T) {
	s := projectionTestStore(t)
	for _, item := range []struct {
		kind, domain string
		value        any
	}{
		{"entry-admission-leases", "lease", admissionLease{}},
		{"admission-budgets", "budget", admissionBudget{}},
	} {
		var usageBefore, before int64
		if err := s.db.QueryRow(`SELECT generation FROM usage_projection_state`).Scan(&usageBefore); err != nil {
			t.Fatal(err)
		}
		if err := s.db.QueryRow(`SELECT generation FROM admission_` + item.domain + `_state`).Scan(&before); err != nil {
			t.Fatal(err)
		}
		if err := s.Put(item.kind, "one", item.value); err != nil {
			t.Fatal(err)
		}
		var after, usageAfter int64
		if err := s.db.QueryRow(`SELECT generation FROM admission_` + item.domain + `_state`).Scan(&after); err != nil {
			t.Fatal(err)
		}
		if err := s.db.QueryRow(`SELECT generation FROM usage_projection_state`).Scan(&usageAfter); err != nil {
			t.Fatal(err)
		}
		if after != before+1 || usageAfter != usageBefore {
			t.Fatalf("domains changed: live %d/%d usage %d/%d", before, after, usageBefore, usageAfter)
		}
	}
}

func TestAdmissionLiveRawKindMovesDirtyBothOwnersNotUsage(t *testing.T) {
	s := projectionTestStore(t)
	if err := s.Put("entry-admission-leases", "one", admissionLease{}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE records SET kind='admission-budgets' WHERE kind='entry-admission-leases'`); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"lease", "budget"} {
		var generation, ack int64
		if err := s.db.QueryRow(`SELECT generation,acknowledged FROM admission_`+d+`_state`).Scan(&generation, &ack); err != nil {
			t.Fatal(err)
		}
		if generation == ack {
			t.Fatalf("raw kind move did not dirty %s", d)
		}
	}
	var generation int64
	if err := s.db.QueryRow(`SELECT generation FROM usage_projection_state`).Scan(&generation); err != nil {
		t.Fatal(err)
	}
	if generation != 0 {
		t.Fatal("live raw write invalidated usage")
	}
}
