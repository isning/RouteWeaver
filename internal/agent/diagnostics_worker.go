package agent

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"os"
	"path/filepath"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"sync"
	"sync/atomic"
	"time"
)

type diagnosticJournal struct {
	Scope        Scope               `json:"scope"`
	Job          *diagnostics.Job    `json:"job,omitempty"`
	Result       *diagnostics.Result `json:"result,omitempty"`
	Acknowledged bool                `json:"acknowledged"`
}
type DiagnosticWorker struct {
	mu       sync.Mutex
	root     string
	scope    Scope
	executor *DiagnosticExecutor
	lock     *os.File
	disk     diagnosticJournal
}

// OpenDiagnosticWorker owns a private journal. An interrupted attempt is never
// re-executed: it reports unknown cost, while a persisted result is retried exactly.
func OpenDiagnosticWorker(root string, scope Scope, executor *DiagnosticExecutor) (*DiagnosticWorker, error) {
	if root == "" || executor == nil || !domain.ValidID(scope.NodeID) || !domain.ValidID(scope.InstanceID) || !domain.ValidID(scope.EnrollmentEpoch) {
		return nil, diagnostics.ErrInvalid
	}
	if e := os.MkdirAll(root, 0700); e != nil {
		return nil, e
	}
	info, e := os.Lstat(root)
	if e != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("diagnostic journal requires a private local directory")
	}
	lock, e := lockRoot(root)
	if e != nil {
		return nil, e
	}
	w := &DiagnosticWorker{root: root, scope: scope, executor: executor, lock: lock, disk: diagnosticJournal{Scope: scope}}
	e = readJSON(filepath.Join(root, "diagnostic.json"), &w.disk)
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		w.Close()
		return nil, e
	}
	if w.disk.Scope != scope {
		w.Close()
		return nil, diagnostics.ErrScope
	}
	return w, nil
}
func (w *DiagnosticWorker) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.lock == nil {
		return nil
	}
	e := unlockRoot(w.lock)
	w.lock = nil
	return e
}
func (w *DiagnosticWorker) save() error {
	return writeJSON(filepath.Join(w.root, "diagnostic.json"), w.disk)
}
func (w *DiagnosticWorker) report(ctx context.Context, tr DiagnosticTransport) error {
	j := w.disk.Job
	r := diagnostics.Report{JobID: j.ID, Scope: w.scope, AttemptID: j.AttemptID, Result: *w.disk.Result}
	if e := tr.ReportDiagnostic(ctx, r); e != nil {
		return e
	}
	w.disk.Acknowledged = true
	return w.save()
}
func (w *DiagnosticWorker) RunOnce(ctx context.Context, tr DiagnosticTransport) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.lock == nil || tr == nil {
		return errors.New("diagnostic worker closed or missing transport")
	}
	if w.disk.Job != nil && !w.disk.Acknowledged {
		if w.disk.Result == nil {
			now := time.Now().UTC()
			w.disk.Result = &diagnostics.Result{Status: "unknown", Phase: "recovery", Code: "interrupted_attempt", Action: "Traffic may have been sent before interruption. No automatic retry was performed.", StartedAt: now, FinishedAt: now, CostKnown: false}
			if e := w.save(); e != nil {
				return e
			}
		}
		return w.report(ctx, tr)
	}
	job, e := tr.ClaimDiagnostic(ctx, w.scope, "diagnostic_"+uuid.NewString())
	if e != nil || job == nil {
		return e
	}
	if e = job.Validate(w.scope); e != nil {
		return e
	}
	if job.Status != "running" {
		return nil
	}
	w.disk = diagnosticJournal{Scope: w.scope, Job: job}
	if e = w.save(); e != nil {
		return e
	}
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	var controlLost atomic.Bool
	go func() {
		defer close(done)
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				current, e := tr.ReadDiagnostic(runCtx, w.scope, job.ID)
				if runCtx.Err() != nil {
					return
				}
				if e != nil || current.Status != "running" || current.AttemptID != job.AttemptID {
					controlLost.Store(e != nil)
					cancel()
					return
				}
			}
		}
	}()
	result := w.executor.Execute(runCtx, *job)
	cancel()
	<-done
	if controlLost.Load() && result.Status == "cancelled" {
		result.Code = "control_connection_lost"
		result.Action = "The cancellation/scope channel failed, so the transfer stopped. Check agent connectivity before retrying."
	}
	w.disk.Result = &result
	if e = w.save(); e != nil {
		return e
	}
	return w.report(ctx, tr)
}
func (w *DiagnosticWorker) Run(ctx context.Context, tr DiagnosticTransport, poll time.Duration, onError func(error)) {
	if poll <= 0 {
		return
	}
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		if e := w.RunOnce(ctx, tr); e != nil && ctx.Err() == nil && onError != nil {
			onError(e)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
