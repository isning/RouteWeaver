package privateipc

import (
	"context"
	"errors"
	"routeweaver/internal/diagnostics"
	"time"
)

// DiagnosticController is optional and available only over owned control pipes.
// It cannot be selected by a network client or carry shell/native config fields.
type DiagnosticController interface {
	RunDiagnostic(context.Context, diagnostics.Job) (diagnostics.Result, error)
	CancelDiagnostic(string, string) error
}
type RunDiagnosticRequest struct {
	Deadline time.Time       `json:"deadline"`
	Job      diagnostics.Job `json:"job"`
}
type CancelDiagnosticRequest struct {
	JobID     string `json:"jobId"`
	AttemptID string `json:"attemptId"`
}

func (c *controlRPC) RunDiagnostic(q RunDiagnosticRequest, out *diagnostics.Result) error {
	controller, ok := c.controller.(DiagnosticController)
	if !ok {
		return errors.New("managed route diagnostics unsupported")
	}
	if q.Job.Validate(q.Job.Scope) != nil || q.Job.PathMode != "managed_route" || q.Job.Status != "running" || q.Job.AttemptID == "" {
		return errors.New("invalid scoped diagnostic")
	}
	deadline := time.Now().Add(31 * time.Second)
	if !q.Deadline.IsZero() && q.Deadline.Before(deadline) {
		deadline = q.Deadline
	}
	ctx, cancel := context.WithDeadline(c.context, deadline)
	defer cancel()
	result, e := controller.RunDiagnostic(ctx, q.Job)
	if errors.Is(e, diagnostics.ErrNotStarted) {
		now := time.Now().UTC()
		*out = diagnostics.Result{Status: "not_run", Phase: "path", Code: "managed_runtime_rejected", Action: "Check the applied entry's unique route/connector mapping and runtime lane before requesting a new diagnostic.", StartedAt: now, FinishedAt: now, CostKnown: true}
		return nil
	}
	if e != nil {
		return errors.New("managed route diagnostic outcome unknown")
	}
	*out = result
	return nil
}
func (c *controlRPC) CancelDiagnostic(q CancelDiagnosticRequest, _ *Empty) error {
	controller, ok := c.controller.(DiagnosticController)
	if !ok {
		return errors.New("managed route diagnostics unsupported")
	}
	if !validAccount.MatchString(q.JobID) || !validAccount.MatchString(q.AttemptID) {
		return errors.New("invalid diagnostic identity")
	}
	return controller.CancelDiagnostic(q.JobID, q.AttemptID)
}

// RunDiagnostic explicitly cancels the remote operation, then waits briefly for
// measured terminal evidence. A caller timeout alone is never evidence of stop.
func (c *ControlClient) RunDiagnostic(ctx context.Context, j diagnostics.Job) (diagnostics.Result, error) {
	callCtx, cancel := context.WithTimeout(context.Background(), 32*time.Second)
	defer cancel()
	deadline := time.Now().Add(time.Duration(j.TimeoutSeconds+1) * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	type outcome struct {
		result diagnostics.Result
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		var out diagnostics.Result
		e := c.call(callCtx, "Control.RunDiagnostic", RunDiagnosticRequest{Deadline: deadline, Job: j}, &out)
		done <- outcome{out, e}
	}()
	select {
	case out := <-done:
		return out.result, out.err
	case <-ctx.Done():
		stopCtx, stop := context.WithTimeout(context.Background(), time.Second)
		_ = c.call(stopCtx, "Control.CancelDiagnostic", CancelDiagnosticRequest{JobID: j.ID, AttemptID: j.AttemptID}, new(Empty))
		stop()
		select {
		case out := <-done:
			return out.result, out.err
		case <-time.After(time.Second):
			return diagnostics.Result{}, errors.New("managed diagnostic cancellation outcome unknown")
		}
	}
}
