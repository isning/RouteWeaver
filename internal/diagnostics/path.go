package diagnostics

import "routeweaver/internal/domain"

// ManagedPath pins observed server forwarding, not a public-client credential.
// There are deliberately no native config, connection secret or user override fields.
type ManagedPath struct {
	RouteID         string    `json:"routeId"`
	DeploymentID    string    `json:"deploymentId"`
	Fingerprint     string    `json:"fingerprint"`
	EntryEndpointID string    `json:"entryEndpointId"`
	ExitEndpointID  string    `json:"exitEndpointId"`
	ConnectorID     string    `json:"connectorId"`
	Hops            []PathHop `json:"hops"`
}
type PathHop struct {
	EndpointID string                    `json:"endpointId"`
	Identity   domain.DeploymentIdentity `json:"identity"`
}

func (p ManagedPath) Validate(scope domain.InstanceScope, routeID string) error {
	if p.RouteID != routeID || !domain.ValidID(p.RouteID) || !domain.ValidID(p.DeploymentID) || len(p.Fingerprint) != 64 || !domain.ValidID(p.EntryEndpointID) || !domain.ValidID(p.ExitEndpointID) || !domain.ValidID(p.ConnectorID) || len(p.Hops) < 1 || len(p.Hops) > 32 {
		return ErrInvalid
	}
	if p.Hops[0].EndpointID != p.EntryEndpointID || p.Hops[len(p.Hops)-1].EndpointID != p.ExitEndpointID {
		return ErrInvalid
	}
	first := p.Hops[0].Identity
	if first.NodeID != scope.NodeID || first.InstanceID != scope.InstanceID || first.EnrollmentEpoch != scope.EnrollmentEpoch {
		return ErrScope
	}
	seen := map[string]bool{}
	for _, h := range p.Hops {
		if !domain.ValidID(h.EndpointID) || seen[h.EndpointID] || !domain.ValidID(h.Identity.NodeID) || !domain.ValidID(h.Identity.InstanceID) || !domain.ValidID(h.Identity.EnrollmentEpoch) || !domain.ValidID(h.Identity.RevisionID) || h.Identity.Generation == 0 || len(h.Identity.Digest) != 64 {
			return ErrInvalid
		}
		seen[h.EndpointID] = true
	}
	return nil
}

// AvailablePath is the public administrative selector. It intentionally omits
// principal UUIDs, connector connection material, and native configuration.
type AvailablePath struct {
	PublishedRouteID string      `json:"publishedRouteId"`
	Name             string      `json:"name"`
	InstanceID       string      `json:"instanceId"`
	NodeID           string      `json:"nodeId"`
	ManagedPath      ManagedPath `json:"managedPath"`
}
