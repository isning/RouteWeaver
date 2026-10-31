package store_test

import (
	"database/sql"
	"math"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestReviewerLiveAggregateOverflowPrecedence(t *testing.T) {
	for _, first := range []bool{true, false} {
		t.Run(map[bool]string{true: "pending-first", false: "overflow-first"}[first], func(t *testing.T) {
			s, _, _, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 100)
			liveWarm(t, s, scope, now)
			pending := "z-pending"
			if first {
				pending = "a-pending"
			}
			for _, id := range []string{"b-one", "c-two"} {
				livePut(t, s, "admission-budgets", id, liveBudget("account", id, uint64(math.MaxInt64/2+1), 0, true, now.Add(time.Hour)))
			}
			livePut(t, s, "admission-budgets", pending, liveBudget("account", pending, 1, 0, true, now))
			v, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "probe"), now)
			if first {
				if err != nil || v.Reason != "quota-budget-pending" {
					t.Fatalf("pending precedence: %+v %v", v, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "reservation aggregate overflow") {
				t.Fatalf("overflow precedence: %+v %v", v, err)
			}
		})
	}
}
func TestReviewerLivePerBudgetRounding(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	liveWarm(t, s, scope, now)
	for _, id := range []string{"one", "two"} {
		b := liveBudget("account", id, 1, 0, true, now.Add(time.Hour))
		b["rate"] = service.Rate{Micros: 1}
		livePut(t, s, "admission-budgets", id, b)
	}
	v := liveExpect(t, s, scope, admissionRequest("entry1", "192.0.2.1", "probe"), now, "")
	if v.ByteBudget == nil || *v.ByteBudget != 98 {
		t.Fatalf("rounded together: %+v", v)
	}
}
func TestReviewerLiveErrorRollsBackSettlement(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, int64(2*store.AdmissionBudgetChunk))
	in := admissionRequest("entry1", "192.0.2.1", "one")
	liveExpect(t, s, scope, in, now, "")
	livePut(t, s, "admission-budgets", "bad", map[string]any{"accountId": []string{"unknown"}})
	in.AdmittedBytes = 10
	if _, err := s.AcquireAdmission(scope, in, now.Add(time.Second)); err == nil {
		t.Fatal("expected typed error")
	}
	u, err := s.Usage("account", time.Time{}, time.Time{})
	if err != nil || u.RawBytes != 0 {
		t.Fatalf("error committed settlement: %+v %v", u, err)
	}
	if err = s.Remove("admission-budgets", "bad"); err != nil {
		t.Fatal(err)
	}
	in.Final = true
	liveExpect(t, s, scope, in, now.Add(2*time.Second), "presence-closed")
	u, err = s.Usage("account", time.Time{}, time.Time{})
	if err != nil || u.RawBytes != 10 {
		t.Fatalf("retry lost settlement: %+v %v", u, err)
	}
}
func TestReviewerLiveOwnExpiryPrecedesUnrelatedTypeError(t *testing.T) {
	s, _, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	in := admissionRequest("entry1", "192.0.2.1", "one")
	liveExpect(t, s, scope, in, now, "")
	livePut(t, s, "admission-budgets", "bad", map[string]any{"accountId": []string{"unknown"}})
	liveExpect(t, s, scope, in, now.Add(31*time.Second), "quota-budget-pending")
}

func TestReviewerLiveDerivedFaultsAndRawBudgetRestore(t *testing.T) {
	for _, fault := range []string{"missing-account", "corrupt-all", "missing-marker", "missing-state", "unknown-version", "missing-trigger", "raw-restore"} {
		t.Run(fault, func(t *testing.T) {
			s, path, _, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 100)
			liveWarm(t, s, scope, now)
			livePut(t, s, "admission-budgets", "reserved", liveBudget("account", "embedded", 30, 0, true, now.Add(time.Hour)))
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			statement := map[string]string{
				"missing-account": `DELETE FROM admission_budget_windows WHERE account<>''`,
				"corrupt-all":     `UPDATE admission_budget_windows SET data=X'00'`,
				"missing-marker":  `DELETE FROM admission_budget_windows WHERE account=''`,
				"missing-state":   `DELETE FROM admission_budget_state`,
				"unknown-version": `UPDATE admission_budget_state SET version=999`,
				"missing-trigger": `DROP TRIGGER admission_budget_insert`,
			}[fault]
			if fault == "raw-restore" {
				var ciphertext []byte
				if err = db.QueryRow(`SELECT data FROM records WHERE kind='admission-budgets' AND id='reserved'`).Scan(&ciphertext); err != nil {
					t.Fatal(err)
				}
				if err = s.Remove("admission-budgets", "reserved"); err != nil {
					t.Fatal(err)
				}
				_, err = db.Exec(`INSERT INTO records(kind,id,data) VALUES('admission-budgets','reserved',?)`, ciphertext)
			} else {
				_, err = db.Exec(statement)
			}
			if err != nil {
				t.Fatal(err)
			}
			v, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "probe"), now)
			if fault == "missing-trigger" {
				if err == nil || v.Allowed {
					t.Fatalf("missing trigger admitted: %+v %v", v, err)
				}
				return
			}
			if err != nil || !v.Allowed || v.ByteBudget == nil || *v.ByteBudget != 70 {
				t.Fatalf("fault %s lost reservation: %+v %v", fault, v, err)
			}
		})
	}
}
