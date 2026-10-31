package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"

	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

type ownershipConflict struct{ detail string }

func (e *ownershipConflict) Error() string { return e.detail }

// Ownership survives stopped, failed and expired generations. Unconfigured is
// explicit provenance for a new nonactivating installation, not a legacy guess.
type instanceOwner struct {
	DeploymentID string `json:"deploymentId,omitempty"`
	Unconfigured bool   `json:"unconfigured,omitempty"`
}

type instanceOwnership struct {
	Writes              []store.RecordWrite
	FirstGenerationOnly bool
}

func (o instanceOwnership) queueWrites(id, action string, generation uint64) ([]store.RecordWrite, error) {
	if o.FirstGenerationOnly && generation != 1 {
		if action == "install" || action == "stop" {
			return nil, nil
		}
		return nil, &ownershipConflict{fmt.Sprintf("instance %s has prior generations but missing ownership evidence; reconcile its publication history before activation", id)}
	}
	return o.Writes, nil
}

// prepareInstanceOwnership returns proof fences and a durable ownership write.
// Callers MUST commit both in the same transaction as desired and generation.
// It never transfers ownership; composition/release require a future protocol.
func (h *server) prepareInstanceOwnership(p *preparedFleet, id, deployment, action string) (instanceOwnership, error) {
	activating := action != "stop" && action != "install"
	var owner instanceOwner
	var desired controlprotocol.Desired
	var state controlprotocol.State
	proofStart := len(p.Compares)
	for _, r := range []struct {
		kind string
		out  any
	}{
		{"instance-owners", &owner}, {"agent-desired", &desired}, {"agent-observations", &state},
	} {
		if e := h.fleetRead(p, r.kind, id, r.out, true); e != nil {
			return instanceOwnership{}, e
		}
	}
	reconcile := func() error {
		return &ownershipConflict{fmt.Sprintf("instance %s ownership cannot be established from accepted publication evidence; reconcile its desired and observed publication history before activation", id)}
	}
	resolve := func(identity controlprotocol.Identity) (string, error) {
		var manifest domain.PublishedManifest
		if e := h.fleetRead(p, "published-manifests", identity.RevisionID, &manifest, false); e != nil {
			if errors.Is(e, store.ErrNotFound) {
				return "", reconcile()
			}
			return "", e
		}
		raw, _ := json.Marshal(identity)
		var expected domain.DeploymentIdentity
		if json.Unmarshal(raw, &expected) != nil || manifest.Identity != expected || manifest.Program.Instance.ID != id || !domain.ValidID(manifest.DeploymentID) {
			return "", reconcile()
		}
		return manifest.DeploymentID, nil
	}
	ownerWasUnconfigured := owner.Unconfigured
	established := owner.DeploymentID
	invalid := owner.Unconfigured && established != "" || established != "" && !domain.ValidID(established)
	if p.Compares[proofStart].Expected != nil && established == "" && !owner.Unconfigured {
		invalid = true
	}
	if p.Compares[proofStart+1].Expected != nil && desired.Generation == 0 {
		invalid = true
	}
	identities := []controlprotocol.Identity{}
	if desired.Generation > 0 && desired.Action != "stop" && desired.Action != "install" {
		identities = append(identities, desired.Identity())
	}
	if state.Observed != nil {
		identities = append(identities, state.Observed.Identity)
	}
	if state.LastKnownValid != nil {
		identities = append(identities, *state.LastKnownValid)
	}
	for _, identity := range identities {
		candidate, e := resolve(identity)
		if e != nil {
			var conflict *ownershipConflict
			if !errors.As(e, &conflict) {
				return instanceOwnership{}, e
			}
			invalid = true
			continue
		}
		if established != "" && established != candidate {
			invalid = true
		}
		if owner.Unconfigured {
			invalid = true
		}
		established = candidate
	}
	// Legacy install/stop without a durable owner is ambiguous even if its current
	// observation is empty. They may have replaced a previously active package.
	if desired.Generation > 0 && established == "" && !owner.Unconfigured {
		invalid = true
	}
	if desired.Generation == 0 && (state.HighestAccepted > 0 || state.Desired != nil) && established == "" {
		invalid = true
	}
	if invalid {
		if activating {
			return instanceOwnership{}, reconcile()
		}
		return instanceOwnership{}, nil // Explicit stop/install must not invent or erase an owner.
	}
	if activating {
		if established != "" && established != deployment {
			return instanceOwnership{}, &ownershipConflict{fmt.Sprintf("instance %s is owned by deployment %s; update that deployment or select a different instance (shared-instance composition is not supported)", id, established)}
		}
		owner = instanceOwner{DeploymentID: deployment}
	} else if established != "" {
		owner = instanceOwner{DeploymentID: established}
	} else {
		owner = instanceOwner{Unconfigured: true}
	}
	return instanceOwnership{Writes: []store.RecordWrite{{Kind: "instance-owners", ID: id, Value: owner}}, FirstGenerationOnly: established == "" && !ownerWasUnconfigured}, nil
}
