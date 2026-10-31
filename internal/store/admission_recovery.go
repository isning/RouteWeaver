package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

type AdmissionBudgetReview struct {
	LeaseID    string         `json:"leaseId"`
	AccountID  string         `json:"accountId"`
	RouteID    string         `json:"routeId"`
	EntryID    string         `json:"entryId"`
	SubjectID  string         `json:"subjectId"`
	Scope      AdmissionScope `json:"scope"`
	Digest     string         `json:"digest"`
	GrantedRaw uint64         `json:"grantedRaw,string"`
	SettledRaw uint64         `json:"settledRaw,string"`
	Finite     bool           `json:"finite"`
	Closed     bool           `json:"closed"`
	Unresolved bool           `json:"unresolved"`
	ExpiresAt  time.Time      `json:"expiresAt"`
}
type AdmissionBudgetResolution struct {
	LeaseID        string    `json:"leaseId"`
	ExpectedDigest string    `json:"expectedDigest"`
	AdmittedBytes  uint64    `json:"admittedBytes,string"`
	RuntimeStopped bool      `json:"runtimeStopped"`
	Reason         string    `json:"reason"`
	Evidence       string    `json:"evidence"`
	ActorID        string    `json:"actorId"`
	At             time.Time `json:"at"`
}

func budgetDigest(b admissionBudget) string {
	raw, _ := json.Marshal(b)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func (s *Store) AdmissionBudgetReviews(instance string, now time.Time) ([]AdmissionBudgetReview, error) {
	raw, e := s.List("entry-admission-leases")
	if e != nil {
		return nil, e
	}
	out := []AdmissionBudgetReview{}
	for _, r := range raw {
		var lease admissionLease
		if e = json.Unmarshal(r, &lease); e != nil {
			return nil, e
		}
		if lease.Scope.InstanceID != instance {
			continue
		}
		var b admissionBudget
		if e = s.Get("admission-budgets", lease.ID, &b); e == ErrNotFound {
			continue
		} else if e != nil {
			return nil, e
		}
		out = append(out, AdmissionBudgetReview{LeaseID: b.LeaseID, AccountID: b.AccountID, RouteID: b.RouteID, EntryID: lease.Binding.EntryID, SubjectID: lease.Binding.SubjectID, Scope: lease.Scope, Digest: budgetDigest(b), GrantedRaw: b.GrantedRaw, SettledRaw: b.SettledRaw, Finite: b.Finite, Closed: b.Closed, Unresolved: !b.Closed && !now.Before(b.ExpiresAt) && (!b.Finite || b.GrantedRaw > b.SettledRaw), ExpiresAt: b.ExpiresAt})
	}
	return out, nil
}

// ResolveAdmissionBudget is an explicit operator attestation, not automated
// inference. It accepts a reviewed final total only after the runtime is stopped;
// the original reservation and durable resolution evidence remain available.
func (s *Store) ResolveAdmissionBudget(instance string, in AdmissionBudgetResolution, now time.Time) error {
	if !in.RuntimeStopped || strings.TrimSpace(in.Reason) == "" || strings.TrimSpace(in.Evidence) == "" || in.ActorID == "" || len(in.Reason) > 2048 || len(in.Evidence) > 2048 {
		return fmt.Errorf("stopped runtime, final measurement evidence, actor and reason required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); e != nil {
		return e
	}
	var lease admissionLease
	if e = s.getTx(tx, "entry-admission-leases", in.LeaseID, &lease); e != nil {
		return e
	}
	if lease.Scope.InstanceID != instance {
		return ErrNotFound
	}
	var b admissionBudget
	if e = s.getTx(tx, "admission-budgets", in.LeaseID, &b); e != nil {
		return e
	}
	if b.Closed || budgetDigest(b) != in.ExpectedDigest {
		return ErrConflict
	}
	if e = s.settleAdmissionBudget(tx, &b, AdmissionRequest{AdmittedBytes: in.AdmittedBytes, Final: true}, now); e != nil {
		return e
	}
	lease.ExpiresAt = now
	if e = s.putTx(tx, "entry-admission-leases", lease.ID, lease); e != nil {
		return e
	}
	in.At = now
	if e = s.putTx(tx, "admission-budget-resolutions", lease.ID, in); e != nil {
		return e
	}
	id := "budget-final:" + lease.ID
	if e = s.putTx(tx, "audit", id, AuditEvent{ID: id, ActorID: in.ActorID, Action: "admission-budget.reviewed-final", TargetID: lease.ID, At: now}); e != nil {
		return e
	}
	return tx.Commit()
}
