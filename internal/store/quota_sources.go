package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"sort"
	"time"
)

// A current proof starts a future observation window. It is never historical
// coverage. All reads belong to the caller's single bounded transaction.
type quotaSourceDependency struct {
	Kind string
	ID   string
}
type quotaSourceProof struct {
	Available    bool
	Reason       string
	Dependencies []quotaSourceDependency
	RouteIDs     []string
}

const quotaSourceRows = 4096
const quotaSourceBytes = 16 << 20
const quotaSourceRecordBytes = 2 << 20
const quotaSourceOwnLimit = 64

var errQuotaSourceBound = errors.New("quota source proof exceeds bounded inventory")

type quotaSourceReader struct {
	s     *Store
	tx    *sql.Tx
	bytes int
	deps  map[quotaSourceDependency]bool
}

func (r *quotaSourceReader) add(kind, id string) error {
	r.deps[quotaSourceDependency{kind, id}] = true
	if len(r.deps) > 512 {
		return errQuotaSourceBound
	}
	return nil
}
func (r *quotaSourceReader) read(kind, id string, out any) error {
	var n int
	var b []byte
	e := r.tx.QueryRow(`SELECT length(data),CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind=? AND id=?`, quotaSourceRecordBytes, kind, id).Scan(&n, &b)
	if e == sql.ErrNoRows {
		return ErrNotFound
	}
	if e != nil {
		return e
	}
	r.bytes += n
	if n > quotaSourceRecordBytes || r.bytes > quotaSourceBytes {
		return errQuotaSourceBound
	}
	if e = r.s.open(kind, id, b, out); e != nil {
		return fmt.Errorf("invalid quota source record")
	}
	return r.add(kind, id)
}
func (r *quotaSourceReader) list(kind string, limit int) (map[string]json.RawMessage, error) {
	rows, e := r.tx.Query(`SELECT id,length(data),CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind=? ORDER BY id LIMIT ?`, quotaSourceRecordBytes, kind, limit+1)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := map[string]json.RawMessage{}
	for rows.Next() {
		var id string
		var n int
		var b []byte
		if e = rows.Scan(&id, &n, &b); e != nil {
			return nil, e
		}
		r.bytes += n
		if n > quotaSourceRecordBytes || r.bytes > quotaSourceBytes || len(out) >= limit {
			return nil, errQuotaSourceBound
		}
		var raw json.RawMessage
		if e = r.s.open(kind, id, b, &raw); e != nil {
			return nil, fmt.Errorf("invalid quota source inventory")
		}
		out[id] = raw
	}
	return out, rows.Err()
}
func quotaSourceUnavailable(reason string) (quotaSourceProof, error) {
	return quotaSourceProof{Reason: reason}, nil
}
func quotaSourceFailure(err error) (quotaSourceProof, error) {
	if errors.Is(err, errQuotaSourceBound) {
		return quotaSourceUnavailable("source_inventory_limit")
	}
	if errors.Is(err, ErrNotFound) {
		return quotaSourceUnavailable("source_incomplete")
	}
	return quotaSourceProof{}, err
}

func (s *Store) quotaSourcesTx(tx *sql.Tx, account string, now time.Time) (quotaSourceProof, error) {
	if !domain.ValidID(account) {
		return quotaSourceUnavailable("invalid_account")
	}
	r := &quotaSourceReader{s: s, tx: tx, deps: map[quotaSourceDependency]bool{}}
	entries, e := r.list("entry-admission-bindings", quotaSourceRows)
	if e != nil {
		return quotaSourceFailure(e)
	}
	meters, e := r.list("meter-bindings", quotaSourceRows)
	if e != nil {
		return quotaSourceFailure(e)
	}
	bindings := map[string]EntryAdmissionBinding{}
	meterBindings := map[string]MeterBinding{}
	for id, raw := range entries {
		var b EntryAdmissionBinding
		if json.Unmarshal(raw, &b) != nil {
			return quotaSourceUnavailable("invalid_binding")
		}
		if b.UserID != account {
			continue
		}
		if id != admissionBindingKey(b.InstanceID, b.EntryID, b.SubjectID, b.CredentialVersion) {
			return quotaSourceUnavailable("invalid_binding")
		}
		if _, e = EntryAdmissionBindingRecord(b); e != nil {
			return quotaSourceUnavailable("invalid_binding")
		}
		if len(bindings) >= quotaSourceOwnLimit {
			return quotaSourceFailure(errQuotaSourceBound)
		}
		bindings[id] = b
		if e = r.add("entry-admission-bindings", id); e != nil {
			return quotaSourceFailure(e)
		}
	}
	for id, raw := range meters {
		var b MeterBinding
		if json.Unmarshal(raw, &b) != nil {
			return quotaSourceUnavailable("invalid_binding")
		}
		if b.UserID != account {
			continue
		}
		if b.LedgerMode != "admission-budget" || b.MeasurementLayer != entrypolicy.MeasurementLayer {
			return quotaSourceUnavailable("ordinary_counter_source")
		}
		if id != bindingKey(b) {
			return quotaSourceUnavailable("invalid_binding")
		}
		if _, e = MeterBindingRecord(b); e != nil {
			return quotaSourceUnavailable("invalid_binding")
		}
		if len(meterBindings) >= quotaSourceOwnLimit {
			return quotaSourceFailure(errQuotaSourceBound)
		}
		meterBindings[id] = b
		if e = r.add("meter-bindings", id); e != nil {
			return quotaSourceFailure(e)
		}
	}
	grantKind := TenantKind(account, "platform-entries")
	grants, e := r.list(grantKind, quotaSourceOwnLimit)
	if e != nil {
		return quotaSourceFailure(e)
	}
	coveredGrants := map[string]bool{}
	coveredMeters := map[string]bool{}
	routes := map[string]bool{}
	manifests := map[string]domain.PublishedManifest{}
	// Load each referenced instance directly, never scan all observations.
	loadManifest := func(instanceID string) (domain.PublishedManifest, error) {
		return quotaSourceManifest(r, instanceID, now)
	}
	for _, b := range bindings {
		var grant admissionGrant
		raw, ok := grants[b.GrantID]
		if !ok {
			return quotaSourceUnavailable("grant_missing")
		}
		if json.Unmarshal(raw, &grant) != nil {
			return quotaSourceUnavailable("invalid_grant")
		}
		if e = r.add(grantKind, b.GrantID); e != nil {
			return quotaSourceFailure(e)
		}
		if grant.ID != b.GrantID || grant.UserID != account {
			return quotaSourceUnavailable("invalid_grant")
		}
		// These exact facts make admissionEligibility reject the old binding.
		// Only managed shadow counters can retire this way; ordinary counters
		// were rejected above. The observation start gate separately requires
		// every previously issued budget to be closed, including revoked ones.
		if grant.Revoked || grant.CredentialVersion != b.CredentialVersion || grant.RouteID != b.RouteID {
			for id, meter := range meterBindings {
				if meter.InstanceID == b.InstanceID && meter.SubjectID == b.SubjectID && meter.RouteID == b.RouteID {
					coveredMeters[id] = true
				}
			}
			continue
		}
		if grant.ID != b.GrantID || grant.UserID != account || grant.RouteID != b.RouteID || grant.CredentialVersion != b.CredentialVersion || grant.SubjectID != b.SubjectID || grant.PublishedRouteID != b.RouteID || grant.DeploymentID == "" || grant.OutputID != b.OutputID || grant.OutputRevision != b.OutputRevision {
			return quotaSourceUnavailable("legacy_or_mismatched_grant")
		}
		if b.OutputID != "" {
			var claim OutputAttributionClaim
			key := admissionBindingKey(b.InstanceID, b.EntryID, b.SubjectID, b.CredentialVersion)
			if e = r.read("output-attribution-claims", key, &claim); e != nil {
				return quotaSourceFailure(e)
			}
			if claim.Binding != b {
				return quotaSourceUnavailable("attribution_mismatch")
			}
			var intent outputAttributionIntent
			if e = r.read(TenantKind(account, "output-attribution-intents"), b.OutputID, &intent); e != nil {
				return quotaSourceFailure(e)
			}
			if intent.Revision != b.OutputRevision || intent.State != "published" {
				return quotaSourceUnavailable("attribution_pending")
			}
		}
		m, ok := manifests[b.InstanceID]
		if !ok {
			m, e = loadManifest(b.InstanceID)
			if e != nil {
				return quotaSourceFailure(e)
			}
			manifests[b.InstanceID] = m
		}
		if m.Program.Instance.AdapterID != "routeweaver/managed-xray" || m.Identity.AdapterID != "routeweaver/managed-xray" || m.DeploymentID != grant.DeploymentID || m.Program.Listener.ID != b.EntryID {
			return quotaSourceUnavailable("not_managed_entry")
		}
		connection, route, err := domain.ResolvePublishedPrincipal(m, b.SubjectID, account, b.RouteID, b.CredentialVersion)
		if err != nil || !reflect.DeepEqual(connection, grant.Connection) || len(route.EndpointIDs) == 0 || len(route.EndpointIDs) > 16 {
			return quotaSourceUnavailable("principal_not_applied")
		}
		var principal domain.ServerPrincipal
		for _, p := range m.Program.Principals {
			if p.SubjectID == b.SubjectID && p.AccountID == account && p.RouteID == b.RouteID && p.CredentialVersion == b.CredentialVersion {
				principal = p
				break
			}
		}
		meterFound := false
		for id, meter := range meterBindings {
			if meter.InstanceID == b.InstanceID && meter.SubjectID == b.SubjectID && meter.RouteID == b.RouteID && meter.PolicyRevision == principal.PolicyRevision && meter.CycleID == principal.CycleID {
				coveredMeters[id] = true
				meterFound = true
			}
		}
		if !meterFound {
			return quotaSourceUnavailable("meter_binding_incomplete")
		}
		for _, endpointID := range route.EndpointIDs {
			var endpoint domain.ManagedEndpoint
			if e = r.read("managed-endpoints", endpointID, &endpoint); e != nil {
				return quotaSourceFailure(e)
			}
			hop, ok := manifests[endpoint.InstanceID]
			if !ok {
				hop, e = loadManifest(endpoint.InstanceID)
				if e != nil {
					return quotaSourceFailure(e)
				}
				manifests[endpoint.InstanceID] = hop
			}
			if endpoint.ID != endpointID || hop.Program.Listener.ID != endpointID || hop.DeploymentID != m.DeploymentID || hop.Fingerprint != m.Fingerprint {
				return quotaSourceUnavailable("path_not_applied")
			}
		}
		coveredGrants[b.GrantID] = true
		routes[b.RouteID] = true
	}
	for id, raw := range grants {
		var g admissionGrant
		if json.Unmarshal(raw, &g) != nil {
			return quotaSourceUnavailable("invalid_grant")
		}
		if e = r.add(grantKind, id); e != nil {
			return quotaSourceFailure(e)
		}
		if g.ID != id || g.UserID != account {
			return quotaSourceUnavailable("invalid_grant")
		}
		if !g.Revoked && !coveredGrants[id] {
			return quotaSourceUnavailable("unbound_grant")
		}
	}
	// No implicit retirement: a historical unaccounted meter source is unknown.
	for id := range meterBindings {
		if !coveredMeters[id] {
			return quotaSourceUnavailable("uncovered_meter_source")
		}
	}
	if len(routes) == 0 {
		return quotaSourceUnavailable("no_managed_sources")
	}
	proof := quotaSourceProof{Available: true}
	for dep := range r.deps {
		proof.Dependencies = append(proof.Dependencies, dep)
	}
	for route := range routes {
		proof.RouteIDs = append(proof.RouteIDs, route)
	}
	sort.Slice(proof.Dependencies, func(i, j int) bool {
		a, b := proof.Dependencies[i], proof.Dependencies[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.ID < b.ID
	})
	sort.Strings(proof.RouteIDs)
	return proof, nil
}

func quotaSourceManifest(r *quotaSourceReader, instanceID string, now time.Time) (domain.PublishedManifest, error) {
	missing := func() (domain.PublishedManifest, error) { return domain.PublishedManifest{}, ErrNotFound }
	var instance domain.CoreInstance
	if e := r.read("core-instances", instanceID, &instance); e != nil {
		return domain.PublishedManifest{}, e
	}
	var requested struct {
		domain.DeploymentIdentity
		Action string `json:"action"`
	}
	if e := r.read("agent-desired", instanceID, &requested); e != nil {
		return domain.PublishedManifest{}, e
	}
	desired := requested.DeploymentIdentity
	switch requested.Action {
	case "", "configure", "start", "rollback", "upgrade":
	default:
		return missing()
	}
	var observation appliedManifestObservation
	if e := r.read("agent-observations", instanceID, &observation); e != nil {
		return domain.PublishedManifest{}, e
	}
	if observation.Phase != "observed_conformant" || !observation.NativeChecked || observation.RecoveryRequired || observation.Observed == nil || !observation.Observed.Known || !observation.Observed.Quiescent || observation.Observed.DeploymentIdentity != desired || desired.Generation == 0 || desired.InstanceID != instanceID || desired.NodeID != instance.HostID || desired.AdapterID != instance.AdapterID || desired.CoreVersion != instance.Version {
		return missing()
	}
	var enrollment struct {
		Scope     domain.InstanceScope `json:"scope"`
		ExpiresAt time.Time            `json:"expiresAt"`
		Revoked   bool                 `json:"revoked"`
	}
	if e := r.read("instance-enrollments", instanceID, &enrollment); e != nil {
		return domain.PublishedManifest{}, e
	}
	if enrollment.Revoked || !now.Before(enrollment.ExpiresAt) || enrollment.Scope != (domain.InstanceScope{NodeID: desired.NodeID, InstanceID: instanceID, EnrollmentEpoch: desired.EnrollmentEpoch}) {
		return missing()
	}
	var m domain.PublishedManifest
	if e := r.read("published-manifests", desired.RevisionID, &m); e != nil {
		return domain.PublishedManifest{}, e
	}
	if m.Identity != desired || m.Program.Instance != instance || m.Fingerprint == "" || !now.Before(m.PolicyExpiresAt) {
		return missing()
	}
	return m, nil
}
