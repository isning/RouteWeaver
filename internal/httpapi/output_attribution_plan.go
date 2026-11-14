package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"routeweaver/internal/auth"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

type attributedDeploymentPlan struct {
	Deployment ServerDeployment
	Writes     []store.RecordWrite
	Bindings   []store.EntryAdmissionBinding
	Compares   []store.RecordCompare
}

func (h *server) prepareAttributedDeployment(in attributedOutputIntent, deploymentID string, now time.Time) (attributedDeploymentPlan, error) {
	out := attributedDeploymentPlan{}
	if in.State != "reserved" && in.State != "provisioning" {
		return out, fmt.Errorf("output intent is not provisioning")
	}
	if !now.Before(in.Deadline) {
		return out, fmt.Errorf("output provisioning expired")
	}
	var original json.RawMessage
	if err := h.s.Get("server-deployments", deploymentID, &original); err != nil {
		return out, err
	}
	if err := json.Unmarshal(original, &out.Deployment); err != nil {
		return out, err
	}
	out.Compares = append(out.Compares, store.RecordCompare{Kind: "server-deployments", ID: deploymentID, Expected: original})
	rates, err := h.s.Rates()
	if err != nil {
		return out, err
	}
	for _, plan := range in.Plans {
		if plan.Grant.DeploymentID != deploymentID {
			continue
		}
		found := false
		for i := range out.Deployment.IR.Programs {
			program := &out.Deployment.IR.Programs[i]
			if program.Instance.ID != plan.InstanceID || program.Listener.ID != plan.EntryID {
				continue
			}
			if program.Instance.AdapterID != render.ServerAdapterManagedXray || program.Instance.Version != render.ManagedXrayVersion {
				return out, fmt.Errorf("unsupported managed runtime")
			}
			for _, existing := range program.Principals {
				if existing.SubjectID == plan.Principal.SubjectID || existing.Credential.UUID == plan.Principal.Credential.UUID {
					return out, fmt.Errorf("principal already exists; recover its migration instead of reprovisioning")
				}
			}
			program.Principals = append(program.Principals, plan.Principal)
			found = true
		}
		if !found {
			return out, fmt.Errorf("authorized entry disappeared")
		}
		grant := plan.Grant
		if grant.UserID != in.Owner || grant.OutputID != in.ID || grant.OutputRevision != in.Revision {
			return out, fmt.Errorf("invalid output credential plan")
		}
		out.Bindings = append(out.Bindings, store.EntryAdmissionBinding{ID: plan.Principal.SubjectID, InstanceID: plan.InstanceID, EntryID: plan.EntryID, SubjectID: plan.Principal.SubjectID, UserID: in.Owner, RouteID: grant.RouteID, GrantID: grant.ID, CredentialVersion: grant.CredentialVersion, OutputID: in.ID, OutputRevision: in.Revision})
		rateID := ""
		rateAt := time.Time{}
		for _, rate := range rates {
			if rate.RouteID == grant.RouteID && !rate.EffectiveAt.After(now) && rate.EffectiveAt.After(rateAt) {
				rateID = rate.ID
				rateAt = rate.EffectiveAt
			}
		}
		meter := store.MeterBinding{ID: plan.Principal.SubjectID, InstanceID: plan.InstanceID, SubjectID: plan.Principal.SubjectID, UserID: in.Owner, RouteID: grant.RouteID, PolicyRevision: plan.Principal.PolicyRevision, CycleID: plan.Principal.CycleID, MeasurementLayer: entrypolicy.MeasurementLayer, LedgerMode: "admission-budget", RateID: rateID, EffectiveAt: now}
		meterRecord, err := store.MeterBindingRecord(meter)
		if err != nil {
			return out, err
		}
		issuedID := plan.InstanceID + ":" + auth.Digest(strings.ToLower(plan.Principal.Credential.UUID))
		writes := []store.RecordWrite{{Kind: store.TenantKind(in.Owner, "platform-entries"), ID: grant.ID, Value: grant}, {Kind: store.TenantKind(in.Owner, "entry-versions"), ID: grant.ID + ":" + grant.CredentialVersion, Value: connectionDigest(grant.Connection)}, {Kind: "issued-principal-credentials", ID: issuedID, Value: plan.Principal.SubjectID}, meterRecord}
		for _, w := range writes {
			out.Compares = append(out.Compares, store.RecordCompare{Kind: w.Kind, ID: w.ID})
			out.Writes = append(out.Writes, w)
		}
	}
	if len(out.Bindings) == 0 {
		return out, fmt.Errorf("no planned managed principals for deployment")
	}
	if _, err := render.DefaultServers().Render(out.Deployment.IR); err != nil {
		return out, err
	}
	out.Deployment.UpdatedAt = now
	return out, nil
}
