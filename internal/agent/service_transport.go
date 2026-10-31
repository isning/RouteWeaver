package agent

import (
	"context"
	"errors"
	"net/http"
	"routeweaver/internal/controlprotocol"
)

type ServiceHeartbeatTransport interface {
	SendServiceHeartbeat(context.Context, controlprotocol.ServiceHeartbeat) (controlprotocol.ServiceHeartbeatResult, error)
}

func (t *HTTPTransport) SendServiceHeartbeat(ctx context.Context, h controlprotocol.ServiceHeartbeat) (controlprotocol.ServiceHeartbeatResult, error) {
	var result controlprotocol.ServiceHeartbeatResult
	if h.Desired.Scope != t.scope || !h.ServiceActive || (h.Observed.Generation != 0 && h.Observed.Scope != t.scope) {
		return result, errors.New("service heartbeat scope mismatch")
	}
	raw, status, err := t.request(ctx, http.MethodPost, t.endpoint("/service-heartbeat"), h)
	if err != nil {
		return result, err
	}
	if status == http.StatusNoContent {
		return result, nil
	}
	if err = decodeWire(raw, &result); err != nil {
		return result, err
	}
	if result.PolicyRefresh != nil && result.PolicyRefresh.Identity != h.Desired {
		return controlprotocol.ServiceHeartbeatResult{}, errors.New("policy refresh identity mismatch")
	}
	return result, nil
}
