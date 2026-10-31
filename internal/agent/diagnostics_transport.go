package agent

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"routeweaver/internal/diagnostics"
)

type DiagnosticTransport interface {
	ClaimDiagnostic(context.Context, Scope, string) (*diagnostics.Job, error)
	ReadDiagnostic(context.Context, Scope, string) (diagnostics.Job, error)
	ReportDiagnostic(context.Context, diagnostics.Report) error
}

func (t *HTTPTransport) ClaimDiagnostic(ctx context.Context, scope Scope, attempt string) (*diagnostics.Job, error) {
	if scope != t.scope {
		return nil, diagnostics.ErrScope
	}
	b, status, e := t.request(ctx, http.MethodPost, t.endpoint("/diagnostics/claim"), map[string]string{"attemptId": attempt})
	if e != nil {
		return nil, e
	}
	if status == http.StatusNoContent {
		return nil, nil
	}
	var j diagnostics.Job
	if e = decodeWire(b, &j); e != nil {
		return nil, e
	}
	if e = j.Validate(scope); e != nil {
		return nil, e
	}
	if j.AttemptID != attempt {
		return nil, errors.New("diagnostic claim mismatch")
	}
	return &j, nil
}
func (t *HTTPTransport) ReadDiagnostic(ctx context.Context, scope Scope, id string) (diagnostics.Job, error) {
	var j diagnostics.Job
	if scope != t.scope {
		return j, diagnostics.ErrScope
	}
	b, _, e := t.request(ctx, http.MethodGet, t.endpoint("/diagnostics/")+url.PathEscape(id), nil)
	if e != nil {
		return j, e
	}
	if e = decodeWire(b, &j); e != nil {
		return j, e
	}
	if j.ID != id {
		return j, errors.New("diagnostic identity mismatch")
	}
	return j, j.Validate(scope)
}
func (t *HTTPTransport) ReportDiagnostic(ctx context.Context, r diagnostics.Report) error {
	if r.Scope != t.scope {
		return diagnostics.ErrScope
	}
	_, _, e := t.request(ctx, http.MethodPost, t.endpoint("/diagnostics/")+url.PathEscape(r.JobID)+"/result", r)
	return e
}
