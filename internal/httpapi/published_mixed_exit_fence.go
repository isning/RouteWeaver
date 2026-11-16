package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

// A mixed exit change is deliberately unavailable when independent-output
// history references the deployment, even if cancelled. Frozen plans are still
// canonical records; neither queue membership nor current principals prove
// that no such plan exists.
func (h *server) mixedExitFence(ctx context.Context, route domain.PublishedRoute, candidate domain.ServerDeploymentIR) (*store.MixedRetargetFence, error) {
	instances := map[string]bool{}
	for _, p := range candidate.Programs {
		instances[p.Instance.ID] = true
		for _, principal := range p.Principals {
			if principal.RouteID == route.ID && strings.HasPrefix(principal.CredentialVersion, "out_") {
				return nil, exitBlocked("EXIT_INDEPENDENT_REFERENCE", "此线路包含独立计量凭据，暂不能更换混合路径出口。")
			}
		}
	}
	valid := func(ids ...string) bool {
		for _, id := range ids {
			if !domain.ValidID(id) {
				return false
			}
		}
		return true
	}
	unavailable := func() error { return fmt.Errorf("independent reference unavailable") }
	binding := func(id string, b store.EntryAdmissionBinding, claim bool) error {
		record, err := store.EntryAdmissionBindingRecord(b)
		if err != nil || record.ID != id || claim && b.OutputID == "" {
			return unavailable()
		}
		if b.OutputID != "" && (b.RouteID == route.ID || instances[b.InstanceID]) {
			return unavailable()
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	fence, err := h.s.CaptureMixedRetargetFence(ctx, route.ID, route.DeploymentID, func(kind, id string, raw json.RawMessage) error {
		if strings.HasPrefix(kind, "tenant/") {
			parts := strings.Split(kind, "/")
			if len(parts) != 3 || !valid(parts[1], id) {
				return unavailable()
			}
			switch parts[2] {
			case "output-attribution-intents":
				var in attributedOutputIntent
				if strictSupported(raw, &in) != nil || in.ID != id || in.Owner != parts[1] || !valid(in.Revision) || len(in.Plans) == 0 {
					return unavailable()
				}
				switch in.State {
				case "reserved", "provisioning", "published", "cancelling", "cancelled", "recovery_required":
				default:
					return unavailable()
				}
				for dep, migration := range in.MigrationIDs {
					if !valid(dep, migration) || dep == route.DeploymentID {
						return unavailable()
					}
				}
				for dep, revision := range in.CapabilityRevisions {
					if !valid(dep) || revision == "" || len(revision) > 256 || dep == route.DeploymentID {
						return unavailable()
					}
				}
				for _, p := range in.Plans {
					if !valid(p.OriginalGrantID, p.InstanceID, p.EntryID, p.Grant.ID, p.Grant.RouteID, p.Grant.DeploymentID, p.Principal.SubjectID, p.Principal.RouteID) || p.Grant.UserID != in.Owner || p.Principal.AccountID != in.Owner || p.Grant.OutputID != in.ID || p.Grant.OutputRevision != in.Revision {
						return unavailable()
					}
					if p.Grant.RouteID == route.ID || p.Grant.PublishedRouteID == route.ID || p.Principal.RouteID == route.ID || p.Grant.DeploymentID == route.DeploymentID || instances[p.InstanceID] {
						return unavailable()
					}
				}
			case "platform-entries":
				var g PublicEntryGrant
				if strictSupported(raw, &g) != nil || g.ID != id || g.UserID != parts[1] || !valid(g.RouteID, g.CredentialVersion) {
					return unavailable()
				}
				if g.OutputID != "" || g.OutputRevision != "" {
					if !valid(g.OutputID, g.OutputRevision, g.PublishedRouteID, g.SubjectID, g.DeploymentID) {
						return unavailable()
					}
					if g.RouteID == route.ID || g.PublishedRouteID == route.ID || g.DeploymentID == route.DeploymentID {
						return unavailable()
					}
				}
			default:
				return unavailable()
			}
			return nil
		}
		switch kind {
		case "entry-admission-bindings":
			var b store.EntryAdmissionBinding
			if strictSupported(raw, &b) != nil {
				return unavailable()
			}
			return binding(id, b, false)
		case "output-attribution-claims":
			var c store.OutputAttributionClaim
			if strictSupported(raw, &c) != nil {
				return unavailable()
			}
			return binding(id, c.Binding, true)
		case "principal-provisioning-locks":
			var lock principalProvisioningLock
			if strictSupported(raw, &lock) != nil || !valid(lock.Owner, lock.OutputID, lock.OutputRevision, lock.MigrationID) || id == route.DeploymentID {
				return unavailable()
			}
		case "principal-service-migrations":
			var m principalServiceMigration
			if strictSupported(raw, &m) != nil || m.ID != id || !valid(m.Owner, m.OutputID, m.OutputRevision, m.DeploymentID) || m.DeploymentID == route.DeploymentID || m.OldDeployment.ID == route.DeploymentID {
				return unavailable()
			}
			for instance := range m.NewIdentities {
				if instances[instance] {
					return unavailable()
				}
			}
			for _, p := range m.OldDeployment.IR.Programs {
				if instances[p.Instance.ID] {
					return unavailable()
				}
			}
		default:
			return unavailable()
		}
		return nil
	})
	if err != nil {
		return nil, exitBlocked("EXIT_INDEPENDENT_REFERENCE", "无法确认此路径不涉及独立计量订阅，暂不能更换混合路径出口。")
	}
	return fence, nil
}
