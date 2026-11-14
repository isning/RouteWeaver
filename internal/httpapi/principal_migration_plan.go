package httpapi

import (
	"fmt"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
)

// validatePrincipalAddition is a structural confinement check, not permission to
// publish. Callers must also validate the current explicit delegation, owner
// policy, path actions and all CAS snapshots in the final writer transaction.
// The proposal may only append fresh principals belonging to the requesting
// account; no pre-existing credential or non-principal configuration may change.
func validatePrincipalAddition(before, after domain.ServerDeploymentIR, owner string, allowedRoutes map[string]bool, maxNew int) ([]domain.ServerPrincipal, error) {
	if !domain.ValidID(owner) || maxNew < 1 || maxNew > 100 || len(before.Programs) != len(after.Programs) {
		return nil, fmt.Errorf("invalid bounded principal migration")
	}
	oldHeader, newHeader := before, after
	oldHeader.Programs, newHeader.Programs = nil, nil
	if !reflect.DeepEqual(oldHeader, newHeader) {
		return nil, fmt.Errorf("deployment metadata changed")
	}
	subjects, credentials := map[string]bool{}, map[string]bool{}
	for _, p := range before.Programs {
		for _, principal := range p.Principals {
			if subjects[principal.SubjectID] {
				return nil, fmt.Errorf("ambiguous existing principal identity")
			}
			subjects[principal.SubjectID] = true
			if principal.Credential.UUID != "" {
				credentials[strings.ToLower(principal.Credential.UUID)] = true
			}
		}
	}
	additions := []domain.ServerPrincipal{}
	for i, p := range before.Programs {
		n := after.Programs[i]
		oldProgram, newProgram := p, n
		oldProgram.Principals, newProgram.Principals = nil, nil
		if !reflect.DeepEqual(oldProgram, newProgram) {
			return nil, fmt.Errorf("non-principal configuration changed")
		}
		if len(n.Principals) < len(p.Principals) {
			return nil, fmt.Errorf("existing principals changed")
		}
		for j := range p.Principals {
			if !reflect.DeepEqual(p.Principals[j], n.Principals[j]) {
				return nil, fmt.Errorf("existing principal changed")
			}
		}
		fresh := n.Principals[len(p.Principals):]
		if len(fresh) > 0 && (p.Instance.AdapterID != render.ServerAdapterManagedXray || p.Instance.Version != render.ManagedXrayVersion || p.Listener.Authentication != "principals") {
			return nil, fmt.Errorf("unmanaged principal target")
		}
		for _, principal := range fresh {
			if principal.AccountID != owner || !allowedRoutes[principal.RouteID] || !domain.ValidID(principal.SubjectID) || !domain.ValidID(principal.CredentialVersion) || principal.Credential.UUID == "" || subjects[principal.SubjectID] || credentials[strings.ToLower(principal.Credential.UUID)] {
				return nil, fmt.Errorf("principal is not fresh and confined to the account routes")
			}
			subjects[principal.SubjectID] = true
			credentials[strings.ToLower(principal.Credential.UUID)] = true
			additions = append(additions, principal)
			if len(additions) > maxNew {
				return nil, fmt.Errorf("principal migration bound exceeded")
			}
		}
	}
	if len(additions) == 0 {
		return nil, fmt.Errorf("empty principal migration")
	}
	return additions, nil
}
