package agent

import (
	"context"
	"errors"
	"net/http"
	"routeweaver/internal/observability"
)

func (t *HTTPTransport) ReportNodeObservation(ctx context.Context, r observability.Report) (observability.Receipt, error) {
	if r.Scope != observability.Scope(t.scope) {
		return observability.Receipt{}, errors.New("transport node observation scope mismatch")
	}
	b, _, e := t.request(ctx, http.MethodPost, t.endpoint("/node-observations"), r)
	if e != nil {
		return observability.Receipt{}, e
	}
	var receipt observability.Receipt
	if e = decodeWire(b, &receipt); e != nil {
		return receipt, e
	}
	if receipt.StreamEpoch != r.StreamEpoch || receipt.Sequence != r.Sequence || receipt.Digest != r.Digest {
		return receipt, errors.New("node observation receipt scope or digest mismatch")
	}
	return receipt, nil
}
