package httpapi

import (
	"encoding/json"
	"fmt"
	"reflect"
	"routeweaver/internal/auth"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

func principalCompensationID(id string) string { return "comp_" + auth.Digest(id)[:32] }

// Remove only exact principals introduced by this receipt. Later additions and
// every non-principal field are retained. Mutable draft drift is checked by the
// migration preparer before any replacement generation can be queued.
func (h *server) principalCompensationCandidate(proof *preparedFleet, source principalServiceMigration, current ServerDeployment) (ServerDeployment, []store.RecordWrite, error) {
	raw, err := json.Marshal(current)
	if err != nil {
		return ServerDeployment{}, nil, err
	}
	var candidate ServerDeployment
	if err = json.Unmarshal(raw, &candidate); err != nil {
		return candidate, nil, err
	}
	if source.DeploymentID != current.ID || len(source.NewIdentities) == 0 {
		return candidate, nil, fmt.Errorf("invalid compensation source")
	}
	remove := map[string]domain.ServerPrincipal{}
	for instance, identity := range source.NewIdentities {
		var manifest domain.PublishedManifest
		if err = h.fleetRead(proof, "published-manifests", identity.RevisionID, &manifest, false); err != nil {
			return candidate, nil, err
		}
		if manifest.DeploymentID != source.DeploymentID || manifest.Program.Instance.ID != instance {
			return candidate, nil, fmt.Errorf("migration manifest scope mismatch")
		}
		old := map[string]bool{}
		for _, program := range source.OldDeployment.IR.Programs {
			if program.Instance.ID == instance {
				for _, p := range program.Principals {
					old[p.SubjectID] = true
				}
			}
		}
		for _, p := range manifest.Program.Principals {
			if !old[p.SubjectID] {
				if p.AccountID != source.Owner {
					return candidate, nil, fmt.Errorf("receipt includes foreign principal")
				}
				remove[p.SubjectID] = p
			}
		}
	}
	if len(remove) == 0 {
		return candidate, nil, fmt.Errorf("receipt contains no newly added principals")
	}
	found := map[string]bool{}
	for i := range candidate.IR.Programs {
		retained := []domain.ServerPrincipal{}
		for _, p := range candidate.IR.Programs[i].Principals {
			if exact, ok := remove[p.SubjectID]; ok {
				if !reflect.DeepEqual(exact, p) {
					return candidate, nil, fmt.Errorf("principal changed after provisioning")
				}
				found[p.SubjectID] = true
			} else {
				retained = append(retained, p)
			}
		}
		candidate.IR.Programs[i].Principals = retained
	}
	if len(found) != len(remove) {
		return candidate, nil, fmt.Errorf("new principal is already absent; reconcile current configuration")
	}
	grants, err := h.fleetList(proof, store.TenantKind(source.Owner, "platform-entries"))
	if err != nil {
		return candidate, nil, err
	}
	writes := []store.RecordWrite{}
	for _, raw := range grants {
		var grant PublicEntryGrant
		if err = json.Unmarshal(raw, &grant); err != nil {
			return candidate, nil, err
		}
		if p, ok := remove[grant.SubjectID]; ok {
			if grant.OutputID != source.OutputID || grant.OutputRevision != source.OutputRevision || grant.CredentialVersion != p.CredentialVersion || grant.UserID != source.Owner || grant.DeploymentID != source.DeploymentID {
				return candidate, nil, fmt.Errorf("grant changed after provisioning")
			}
			grant.Revoked = true
			writes = append(writes, store.RecordWrite{Kind: store.TenantKind(source.Owner, "platform-entries"), ID: grant.ID, Value: grant})
		}
	}
	if len(writes) != len(remove) {
		return candidate, nil, fmt.Errorf("compensation requires all exact new grants")
	}
	return candidate, writes, nil
}

func (h *server) preparePrincipalServiceCompensation(owner, id string) (preparedPrincipalMigration, error) {
	var source principalServiceMigration
	proof := preparedFleet{}
	if err := h.fleetRead(&proof, "principal-service-migrations", id, &source, false); err != nil {
		return preparedPrincipalMigration{}, err
	}
	if source.Owner != owner {
		return preparedPrincipalMigration{}, store.ErrNotFound
	}
	var current ServerDeployment
	if err := h.fleetRead(&proof, "server-deployments", source.DeploymentID, &current, false); err != nil {
		return preparedPrincipalMigration{}, err
	}
	candidate, writes, err := h.principalCompensationCandidate(&proof, source, current)
	if err != nil {
		return preparedPrincipalMigration{}, err
	}
	p, err := h.preparePrincipalServiceMutation(principalCompensationID(id), owner, source.OutputID, source.OutputRevision, source.CapabilityRevision, candidate, writes, &source)
	if err != nil {
		return p, err
	}
	p.Proof.Compares = append(p.Proof.Compares, proof.Compares...)
	p.Proof.Sets = append(p.Proof.Sets, proof.Sets...)
	return p, nil
}
func (h *server) queuePrincipalServiceCompensation(p preparedPrincipalMigration, compares []store.RecordCompare, writes []store.RecordWrite) error {
	if p.Receipt.SourceMigrationID == "" {
		return fmt.Errorf("not a compensation plan")
	}
	p.Proof.Compares = append(p.Proof.Compares, compares...)
	_, err := h.s.CompareServicePolicyAndGenerateRecords(p.Fence, "agent-desired", p.TargetIDs, p.Proof.Compares, p.Proof.Sets, func(g map[string]uint64) ([]store.RecordWrite, error) {
		built, e := p.build(g)
		return append(built, writes...), e
	})
	return err
}
