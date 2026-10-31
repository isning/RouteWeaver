package agent

import (
	"context"
	"routeweaver/internal/diagnosticexec"
	"routeweaver/internal/diagnostics"
	"time"
)

type DiagnosticExecutorOptions struct{ LoopbackTargets map[string]string }
type DiagnosticExecutor struct {
	direct  *diagnosticexec.Executor
	managed func(context.Context, diagnostics.Job) diagnostics.Result
}

func NewDiagnosticExecutor(o DiagnosticExecutorOptions) *DiagnosticExecutor {
	return &DiagnosticExecutor{direct: diagnosticexec.New(diagnosticexec.Options{LoopbackTargets: o.LoopbackTargets})}
}
func (e *DiagnosticExecutor) Execute(ctx context.Context, j diagnostics.Job) diagnostics.Result {
	if j.PathMode == "managed_route" {
		if e.managed != nil {
			return e.managed(ctx, j)
		}
		now := time.Now().UTC()
		return diagnostics.Result{Status: "not_run", Phase: "path", Code: "managed_probe_unavailable", Action: "Run this job on the currently applied managed entry instance.", StartedAt: now, FinishedAt: now, CostKnown: true}
	}
	return e.direct.Execute(ctx, j)
}
