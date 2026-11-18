package agent

import (
	"context"
	"errors"
	"net/http"
	"routeweaver/internal/observability"
)

func (t *HTTPTransport) ReportNodeObservation(ctx context.Context, r observability.Report) (observability.Receipt, error) {
	path := t.endpoint("/node-observations")
	expected := observability.Scope(t.scope)
	if t.scope.InstanceID == "host-agent" && r.HostAgent {
		expected.InstanceID = ""
		path = "/api/agent/hosts/" + t.scope.NodeID + "/node-observations"
	}
	if r.Scope != expected || (r.HostAgent && t.scope.InstanceID != "host-agent") {
		return observability.Receipt{}, errors.New("transport node observation scope mismatch")
	}
	b, _, e := t.request(ctx, http.MethodPost, path, r)
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
