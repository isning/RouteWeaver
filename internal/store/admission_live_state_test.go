package store_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"routeweaver/internal/store"
	"sort"
	"sync"
	"testing"
	"time"
)

// Infrastructure faults are injected through SQLite; the decision is observed
// only at the public admission seam, never through a private projection helper.
func TestAdmissionLiveDerivedFaultsRebuildCanonicalObligations(t *testing.T) {
	for _, domain := range []string{"lease", "budget"} {
		for _, fault := range []string{"row", "ciphertext", "marker", "version", "trigger"} {
			t.Run(domain+"/"+fault, func(t *testing.T) {
				s, path, _, scope, now := admissionFixture(t)
				finiteAdmissionPlan(t, s, 100)
				first, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "first"), now)
				if err != nil || !first.Allowed {
					t.Fatalf("seed %+v %v", first, err)
				}
				db, err := sql.Open("sqlite", path)
				if err != nil {
					t.Fatal(err)
				}
				defer db.Close()
				table := "admission_" + domain + "_windows"
				query := `DELETE FROM ` + table + ` WHERE account<>''`
				switch fault {
				case "ciphertext":
					query = `UPDATE ` + table + ` SET data=X'00' WHERE account<>''`
				case "marker":
					query = `DELETE FROM ` + table + ` WHERE account=''`
				case "version":
					query = `UPDATE admission_` + domain + `_state SET version=999`
				case "trigger":
					query = `DROP TRIGGER admission_` + domain + `_update`
				}
				if _, err = db.Exec(query); err != nil {
					t.Fatal(err)
				}
				ip := "192.0.2.1"
				want := "quota-reserved"
				if domain == "lease" {
					ip = "192.0.2.2"
					want = "ip-limit"
				}
				out, err := s.AcquireAdmission(scope, admissionRequest("entry2", ip, "second"), now.Add(time.Second))
				if fault == "trigger" {
					if err == nil {
						t.Fatalf("missing trigger trusted: %+v", out)
					}
					return
				}
				if err != nil || out.Allowed || out.Reason != want {
					t.Fatalf("lost canonical obligation: %+v %v; want %s", out, err, want)
				}
			})
		}
	}
}
func TestAdmissionLiveBudgetsHaveNoPresenceCapacityBound(t *testing.T) {
	s, path, key, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 1<<40)
	first := admissionRequest("entry1", "192.0.2.1", "seed")
	out, err := s.AcquireAdmission(scope, first, now)
	if err != nil || !out.Allowed {
		t.Fatal(out, err)
	}
	if err = s.ReleaseAdmission(scope, out.LeaseID, now); err != nil {
		t.Fatal(err)
	}
	rows, err := s.List("admission-budgets")
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	s = reopened
	// Invalidate derived rows using a second normal Store reopen, keeping all
	// writes at the generic public seam and avoiding O(n²) fixture construction.
	// The records preserve the exact shape of a publicly issued live obligation.
	for start := 0; start < 4097; start += 500 {
		writes := []store.RecordWrite{}
		for i := start; i < 4097 && i < start+500; i++ {
			var v map[string]any
			if err = json.Unmarshal(rows[0], &v); err != nil {
				t.Fatal(err)
			}
			id := fmt.Sprintf("obligation-%04d", i)
			v["leaseId"] = id
			writes = append(writes, store.RecordWrite{Kind: "admission-budgets", ID: id, Value: v})
		}
		if err = s.CompareAndPutRecords(nil, writes); err != nil {
			t.Fatal(err)
		}
	}
	out, err = s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "new"), now.Add(time.Second))
	if err != nil || !out.Allowed {
		t.Fatalf("budgets incorrectly bounded by presence cap: %+v %v", out, err)
	}
}
func TestAdmissionLiveObligationChurnCharacterization(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_MEASURE_ADMISSION_LIVE") != "1" {
		t.Skip("explicit live obligation characterization not requested")
	}
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 1<<40)
	for i := 0; i <= 256; i++ {
		in := admissionRequest("entry1", "192.0.2.1", fmt.Sprintf("churn-%d", i))
		start := time.Now()
		out, err := s.AcquireAdmission(scope, in, now)
		elapsed := time.Since(start)
		if err != nil || !out.Allowed {
			t.Fatalf("churn %d: %+v %v", i, out, err)
		}
		if err = s.ReleaseAdmission(scope, out.LeaseID, now); err != nil {
			t.Fatal(err)
		}
		if i == 0 || i == 64 || i == 256 {
			t.Logf("released live obligations=%d admission=%s (not closed history)", i, elapsed)
		}
	}
}
func TestAdmissionConcurrentArrivalCharacterization(t *testing.T) {
	if os.Getenv("ROUTEWEAVER_MEASURE_ADMISSION_LIVE") != "1" {
		t.Skip("explicit concurrent arrival characterization not requested")
	}
	s, path, key, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 1<<40)
	first := admissionRequest("entry1", "192.0.2.1", "seed")
	out, err := s.AcquireAdmission(scope, first, now)
	if err != nil || !out.Allowed {
		t.Fatal(out, err)
	}
	first.Final = true
	if _, err = s.AcquireAdmission(scope, first, now); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"admission-budgets", "entry-admission-leases"} {
		rows, err := s.List(kind)
		if err != nil {
			t.Fatal(err)
		}
		for base := 0; base < 1000; base += 500 {
			writes := []store.RecordWrite{}
			for i := base; i < base+500; i++ {
				writes = append(writes, store.RecordWrite{Kind: kind, ID: fmt.Sprintf("closed-%04d", i), Value: rows[0]})
			}
			if err = s.CompareAndPutRecords(nil, writes); err != nil {
				t.Fatal(err)
			}
		}
	}
	peer, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	inputs := []store.AdmissionRequest{admissionRequest("entry1", "192.0.2.1", "one"), admissionRequest("entry1", "192.0.2.1", "two")}
	for _, in := range inputs {
		if out, err = s.AcquireAdmission(scope, in, now); err != nil || !out.Allowed {
			t.Fatal(out, err)
		}
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	durations := []time.Duration{}
	failures := []string{}
	start := make(chan struct{})
	for n, handle := range []*store.Store{s, peer} {
		wg.Add(1)
		go func(n int, handle *store.Store) {
			defer wg.Done()
			<-start
			for i := 0; i < 20; i++ {
				at := now.Add(time.Duration(i*2+n+1) * time.Millisecond)
				before := time.Now()
				out, err := handle.AcquireAdmission(scope, inputs[n], at)
				elapsed := time.Since(before)
				mu.Lock()
				durations = append(durations, elapsed)
				if err != nil || !out.Allowed {
					failures = append(failures, fmt.Sprintf("%+v %v", out, err))
				}
				mu.Unlock()
			}
		}(n, handle)
	}
	close(start)
	wg.Wait()
	if len(failures) > 0 {
		t.Fatal(failures)
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	t.Logf("2 handles, arrival times possibly reordered, 1000 closed pairs, n=%d median=%s max=%s; backwards-time reconstruction remains linear", len(durations), durations[len(durations)/2], durations[len(durations)-1])
}
