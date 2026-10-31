package store

import (
	"database/sql"
	"errors"

	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"sort"
	"time"
)

// Diagnostic mutations reserve the SQLite writer before reading scope or jobs.
// There is one active diagnostic per physical node, including across instances.
func (s *Store) diagnosticTransaction(change func(*sql.Tx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`UPDATE counters SET value=value WHERE kind='diagnostic-lock'`); e != nil {
		return e
	}
	if e = change(tx); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) diagnosticEnrollment(tx *sql.Tx, scope domain.InstanceScope, now time.Time) error {
	var latest struct {
		Scope     domain.InstanceScope `json:"scope"`
		Revoked   bool                 `json:"revoked"`
		ExpiresAt time.Time            `json:"expiresAt"`
	}
	if s.getTx(tx, "instance-enrollments", scope.InstanceID, &latest) != nil || latest.Scope != scope || latest.Revoked || !now.Before(latest.ExpiresAt) {
		return diagnostics.ErrScope
	}
	var instance domain.CoreInstance
	if s.getTx(tx, "core-instances", scope.InstanceID, &instance) != nil || instance.HostID != scope.NodeID {
		return diagnostics.ErrScope
	}
	return nil
}
func (s *Store) diagnosticJobsTx(tx *sql.Tx) ([]diagnostics.Job, error) {
	rows, e := tx.Query(`SELECT id,data FROM records WHERE kind='diagnostic-jobs'`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []diagnostics.Job{}
	for rows.Next() {
		var id string
		var b []byte
		if e = rows.Scan(&id, &b); e != nil {
			return nil, e
		}
		var j diagnostics.Job
		if e = s.open("diagnostic-jobs", id, b, &j); e != nil {
			return nil, e
		}
		out = append(out, j)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RequestedAt.Before(out[j].RequestedAt) })
	return out, rows.Err()
}
func (s *Store) CreateDiagnosticTarget(t diagnostics.Target, actor string, now time.Time) error {
	if e := t.Validate(); e != nil {
		return e
	}
	return s.diagnosticTransaction(func(tx *sql.Tx) error {
		var host domain.Host
		if e := s.getTx(tx, "hosts", t.NodeID, &host); e != nil {
			return e
		}
		var old diagnostics.Target
		e := s.getTx(tx, "diagnostic-targets", t.ID, &old)
		if e == nil {
			if diagnostics.Digest(old) == diagnostics.Digest(t) {
				return nil
			}
			return ErrConflict
		}
		if e != ErrNotFound {
			return e
		}
		if e = s.putTx(tx, "diagnostic-targets", t.ID, t); e != nil {
			return e
		}
		return s.diagnosticAuditTx(tx, actor, "diagnostic.target-authorized", t.ID, now)
	})
}
func (s *Store) diagnosticAuditTx(tx *sql.Tx, actor, action, id string, now time.Time) error {
	return s.putTx(tx, "audit", action+"_"+id, AuditEvent{ID: action + "_" + id, ActorID: actor, Action: action, TargetID: id, At: now})
}
func (s *Store) RequestDiagnostic(r diagnostics.Request, actor string, now time.Time) (out diagnostics.Job, err error) {
	err = s.diagnosticTransaction(func(tx *sql.Tx) error {
		if e := s.getTx(tx, "diagnostic-jobs", r.ID, &out); e == nil {
			if diagnostics.Digest(out.Request) == diagnostics.Digest(r) && out.RequestedBy == actor {
				return nil
			}
			return ErrConflict
		} else if e != ErrNotFound {
			return e
		}
		var target diagnostics.Target
		if e := s.getTx(tx, "diagnostic-targets", r.TargetID, &target); e != nil {
			return e
		}
		var latest struct {
			Scope domain.InstanceScope `json:"scope"`
		}
		if e := s.getTx(tx, "instance-enrollments", r.InstanceID, &latest); e != nil {
			return e
		}
		if e := s.diagnosticEnrollment(tx, latest.Scope, now); e != nil {
			return e
		}
		var e error
		out, e = diagnostics.NewJob(r, target, latest.Scope, actor, now)
		if e != nil {
			return e
		}
		if r.PathMode == "managed_route" {
			out.ManagedPath, e = s.selectDiagnosticPathTx(tx, r.PublishedRouteID, r.InstanceID, now)
			if e != nil {
				return e
			}
		}
		if e = out.Validate(latest.Scope); e != nil {
			return e
		}
		jobs, e := s.diagnosticJobsTx(tx)
		if e != nil {
			return e
		}
		pending := 0
		for _, j := range jobs {
			if j.Scope.NodeID == out.Scope.NodeID && !diagnostics.Terminal(j.Status) && now.Before(j.ExpiresAt) {
				pending++
			}
		}
		if pending >= 8 {
			return errors.New("node diagnostic queue is full; wait for existing jobs")
		}
		if e = s.putTx(tx, "diagnostic-jobs", out.ID, out); e != nil {
			return e
		}
		return s.diagnosticAuditTx(tx, actor, "diagnostic.requested", out.ID, now)
	})
	return
}
func (s *Store) settleDiagnosticTx(tx *sql.Tx, j diagnostics.Job, now time.Time) (diagnostics.Job, error) {
	if diagnostics.Terminal(j.Status) {
		return j, nil
	}
	expired := !now.Before(j.ExpiresAt)
	if j.ClaimedAt != nil && !now.Before(j.ClaimedAt.Add(time.Duration(j.TimeoutSeconds+15)*time.Second)) {
		expired = true
	}
	scopeErr := s.diagnosticEnrollment(tx, j.Scope, now)
	pathErr := s.diagnosticPathCurrentTx(tx, j, now)
	if !expired && scopeErr == nil && pathErr == nil {
		return j, nil
	}
	status, code, action := "not_run", "queue_expired", "The agent did not start before expiry. Check agent connectivity and request a new diagnostic."
	known := true
	if j.ClaimedAt != nil {
		status = "unknown"
		code = "result_missing"
		known = false
		action = "Execution may have consumed traffic. Check the agent before requesting another diagnostic; no retry was scheduled."
	}
	if scopeErr != nil {
		code = "enrollment_changed"
		action = "The enrollment changed. Check the node and request a new diagnostic against its current enrollment."
	}
	if pathErr != nil {
		code = "path_changed"
		action = "The selected applied path changed or its observation/lease expired. Check every hop and select the current path; no automatic retry was scheduled."
	}
	j.Status = status
	j.Result = &diagnostics.Result{Status: status, Phase: "dispatch", Code: code, Action: action, StartedAt: now, FinishedAt: now, CostKnown: known}
	return j, s.putTx(tx, "diagnostic-jobs", j.ID, j)
}
func (s *Store) DiagnosticJobs(now time.Time) (out []diagnostics.Job, err error) {
	err = s.diagnosticTransaction(func(tx *sql.Tx) error {
		jobs, e := s.diagnosticJobsTx(tx)
		if e != nil {
			return e
		}
		out = []diagnostics.Job{}
		for _, j := range jobs {
			j, e = s.settleDiagnosticTx(tx, j, now)
			if e != nil {
				return e
			}
			out = append(out, j)
		}
		return nil
	})
	return
}
func (s *Store) DiagnosticJob(id string, now time.Time) (out diagnostics.Job, err error) {
	err = s.diagnosticTransaction(func(tx *sql.Tx) error {
		if e := s.getTx(tx, "diagnostic-jobs", id, &out); e != nil {
			return e
		}
		var e error
		out, e = s.settleDiagnosticTx(tx, out, now)
		return e
	})
	return
}
func (s *Store) ClaimDiagnostic(scope domain.InstanceScope, attempt string, now time.Time) (out *diagnostics.Job, err error) {
	if !domain.ValidID(attempt) {
		return nil, diagnostics.ErrInvalid
	}
	err = s.diagnosticTransaction(func(tx *sql.Tx) error {
		if e := s.diagnosticEnrollment(tx, scope, now); e != nil {
			return e
		}
		jobs, e := s.diagnosticJobsTx(tx)
		if e != nil {
			return e
		}
		var next *diagnostics.Job
		for _, j := range jobs {
			j, e = s.settleDiagnosticTx(tx, j, now)
			if e != nil {
				return e
			}
			if j.Scope == scope && j.AttemptID == attempt {
				copy := j
				out = &copy
				return nil
			}
			// Unknown is evidence of neither completion nor stop. Hold the shared
			// node lane until the remote executor's hard window has elapsed.
			uncertainLive := j.Status == "unknown" && j.ClaimedAt != nil && now.Before(j.ClaimedAt.Add(time.Duration(j.TimeoutSeconds+15)*time.Second))
			if j.Scope.NodeID == scope.NodeID && (j.Status == "running" || j.Status == "cancel_requested" || uncertainLive) {
				return nil
			}
			if next == nil && j.Scope == scope && j.Status == "queued" {
				copy := j
				next = &copy
			}
		}
		if next == nil {
			return nil
		}
		next.Status = "running"
		next.AttemptID = attempt
		next.ClaimedAt = &now
		if e = s.putTx(tx, "diagnostic-jobs", next.ID, *next); e != nil {
			return e
		}
		out = next
		return nil
	})
	return
}
func (s *Store) CancelDiagnostic(id, actor string, now time.Time) (out diagnostics.Job, err error) {
	err = s.diagnosticTransaction(func(tx *sql.Tx) error {
		if e := s.getTx(tx, "diagnostic-jobs", id, &out); e != nil {
			return e
		}
		var e error
		out, e = s.settleDiagnosticTx(tx, out, now)
		if e != nil {
			return e
		}
		if diagnostics.Terminal(out.Status) {
			return nil
		}
		if out.Status == "queued" {
			out.Status = "not_run"
			out.Result = &diagnostics.Result{Status: "not_run", Phase: "dispatch", Code: "cancelled_before_start", Action: "No diagnostic traffic was sent.", StartedAt: now, FinishedAt: now, CostKnown: true}
		} else {
			out.Status = "cancel_requested"
		}
		if e = s.putTx(tx, "diagnostic-jobs", id, out); e != nil {
			return e
		}
		return s.diagnosticAuditTx(tx, actor, "diagnostic.cancel-requested", id, now)
	})
	return
}
func (s *Store) AcceptDiagnosticReport(report diagnostics.Report, now time.Time) error {
	return s.diagnosticTransaction(func(tx *sql.Tx) error {
		if e := s.diagnosticEnrollment(tx, report.Scope, now); e != nil {
			return e
		}
		var j diagnostics.Job
		if e := s.getTx(tx, "diagnostic-jobs", report.JobID, &j); e != nil {
			return e
		}
		if e := report.Validate(j); e != nil {
			return e
		}
		missingOutcome := j.Status == "unknown" && j.Result != nil && j.Result.Phase == "dispatch" && (j.Result.Code == "result_missing" || j.Result.Code == "path_changed")
		if j.Result != nil {
			if diagnostics.Digest(j.Result) == diagnostics.Digest(report.Result) || j.ReportDigest == diagnostics.Digest(report) {
				return nil
			}
			// A late, durable report refines missing evidence, never starts traffic.
			// A previously accepted agent result remains immutable.
			if !missingOutcome {
				return ErrConflict
			}
		}
		if j.Status != "running" && j.Status != "cancel_requested" && !missingOutcome {
			return ErrConflict
		}
		if report.Result.FinishedAt.After(now.Add(5*time.Second)) || report.Result.StartedAt.Before(j.RequestedAt.Add(-5*time.Second)) {
			return diagnostics.ErrInvalid
		}
		if j.ClaimedAt == nil {
			return diagnostics.ErrInvalid
		}
		if report.Result.Status != "unknown" {
			if report.Result.StartedAt.Before(j.ClaimedAt.Add(-5*time.Second)) || report.Result.FinishedAt.After(j.ClaimedAt.Add(time.Duration(j.TimeoutSeconds+15)*time.Second)) || report.Result.DurationMS > int64(j.TimeoutSeconds+1)*1000 {
				return diagnostics.ErrInvalid
			}
		}
		j.ReportDigest = diagnostics.Digest(report)
		if (j.Result != nil && j.Result.Code == "path_changed") || s.diagnosticPathCurrentTx(tx, j, now) != nil {
			if report.Result.Status != "not_run" && report.Result.Status != "unknown" {
				report.Result.Status = "failed"
			}
			report.Result.Phase = "path"
			report.Result.Code = "path_changed"
			report.Result.Action = "Measured payload belongs to a path whose applied identity or lease changed. Select the current fully observed path before another diagnostic."
			report.Result.BytesPerSecond = nil
		}
		j.Result = &report.Result
		j.Status = report.Result.Status
		return s.putTx(tx, "diagnostic-jobs", j.ID, j)
	})
}

// DiagnosticJobForScope provides the cancellation poll under the current scope.
func (s *Store) DiagnosticJobForScope(id string, scope domain.InstanceScope, now time.Time) (out diagnostics.Job, err error) {
	err = s.diagnosticTransaction(func(tx *sql.Tx) error {
		if e := s.diagnosticEnrollment(tx, scope, now); e != nil {
			return e
		}
		if e := s.getTx(tx, "diagnostic-jobs", id, &out); e != nil {
			return e
		}
		if out.Scope != scope {
			return diagnostics.ErrScope
		}
		var e error
		out, e = s.settleDiagnosticTx(tx, out, now)
		return e
	})
	return
}
