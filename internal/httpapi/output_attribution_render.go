package httpapi

import (
	"encoding/json"
	"fmt"
)

type outputAttribution struct {
	Revision string            `json:"revision"`
	Grants   map[string]string `json:"grants"` // stable profile entry ID -> isolated grant ID
}

type attributedOutputReader struct {
	inputs      *templateInputs
	owner       string
	outputID    string
	attribution *outputAttribution
}

func (r attributedOutputReader) TenantGet(owner, kind, id string, out any) error {
	if owner != r.owner {
		return fmt.Errorf("output owner mismatch")
	}
	if kind != "platform-entries" {
		return r.inputs.TenantGet(owner, kind, id, out)
	}
	grantID, ok := r.attribution.Grants[id]
	if !ok {
		return fmt.Errorf("profile added a route without an isolated credential; create a new independently metered subscription")
	}
	var grant PublicEntryGrant
	if err := r.inputs.TenantGet(owner, kind, grantID, &grant); err != nil {
		return err
	}
	if grant.ID != grantID || grant.UserID != owner || grant.OutputID != r.outputID || grant.OutputRevision != r.attribution.Revision || grant.PublishedRouteID == "" {
		return fmt.Errorf("isolated credential does not belong to this output")
	}
	// Profile references remain stable; access dependencies below retain the real
	// immutable grant identity. Never persist this display-ID projection.
	grant.ID = id
	raw, err := json.Marshal(grant)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}
