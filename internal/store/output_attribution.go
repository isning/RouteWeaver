package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"time"
)

type outputAttributionIntent struct {
	Revision string `json:"revision"`
	State    string `json:"state"`
}

// Claims contain no credentials. They are immutable provenance snapshots, not
// authorization to publish a deployment or to expose an output.
type OutputAttributionClaim struct {
	Binding EntryAdmissionBinding `json:"binding"`
}

func (s *Store) outputAttributionEligibleTx(tx *sql.Tx, b EntryAdmissionBinding, g admissionGrant) error {
	if b.OutputID == "" && b.OutputRevision == "" {
		if g.OutputID != "" || g.OutputRevision != "" {
			return ErrConflict
		}
		return nil
	}
	if !domain.ValidID(b.OutputID) || !domain.ValidID(b.OutputRevision) || g.OutputID != b.OutputID || g.OutputRevision != b.OutputRevision {
		return ErrConflict
	}
	var claim OutputAttributionClaim
	if err := s.getTx(tx, "output-attribution-claims", admissionBindingKey(b.InstanceID, b.EntryID, b.SubjectID, b.CredentialVersion), &claim); err != nil {
		return err
	}
	if claim.Binding != b {
		return ErrConflict
	}
	var intent outputAttributionIntent
	if err := s.getTx(tx, TenantKind(b.UserID, "output-attribution-intents"), b.OutputID, &intent); err != nil {
		return err
	}
	if intent.Revision != b.OutputRevision || intent.State != "published" {
		return ErrConflict
	}
	return nil
}

// ComparePolicyAndPutAttributedRecords provisions new bindings only against an
// existing owner-scoped reservation. All grant/deployment writes, immutable
// claims, bindings, and policy comparisons commit or roll back together.
// The caller must separately fence inventory, deployment and credential inputs.
// This helper does not publish a deployment and cannot upgrade a legacy binding.
func (s *Store) ComparePolicyAndPutAttributedRecords(expected service.EffectivePolicy, outputID, revision string, bindings []EntryAdmissionBinding, compares []RecordCompare, writes []RecordWrite) error {
	if !domain.ValidID(expected.UserID) || !domain.ValidID(outputID) || !domain.ValidID(revision) || len(bindings) == 0 || len(bindings) > 100 {
		return fmt.Errorf("bounded complete output attribution required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); err != nil {
		return err
	}
	actual, err := s.effectivePolicyTx(tx, expected.UserID, time.Now().UTC())
	if err != nil {
		return err
	}
	if actual.Status != "active" || !reflect.DeepEqual(actual, expected) {
		return ErrConflict
	}
	if err = s.compareRecordsTx(tx, compares, nil); err != nil {
		return err
	}
	all, err := s.prepareOutputAttributionWritesTx(tx, expected, outputID, revision, bindings, writes)
	if err != nil {
		return err
	}
	for _, w := range all {
		if err = s.putTx(tx, w.Kind, w.ID, w.Value); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// prepareOutputAttributionWritesTx is for the atomic service-migration publisher.
// Its caller must acquire the writer lock and fence the current effective policy
// before calling, then commit these returned records with desired generations.
func (s *Store) prepareOutputAttributionWritesTx(tx *sql.Tx, expected service.EffectivePolicy, outputID, revision string, bindings []EntryAdmissionBinding, writes []RecordWrite) ([]RecordWrite, error) {
	if !domain.ValidID(expected.UserID) || !domain.ValidID(outputID) || !domain.ValidID(revision) || len(bindings) == 0 || len(bindings) > 100 {
		return nil, fmt.Errorf("bounded complete output attribution required")
	}
	var err error
	var intent outputAttributionIntent
	if err = s.getTx(tx, TenantKind(expected.UserID, "output-attribution-intents"), outputID, &intent); err != nil {
		return nil, err
	}
	if intent.Revision != revision || (intent.State != "reserved" && intent.State != "provisioning") {
		return nil, ErrConflict
	}
	// Reject duplicate caller writes and any attempt to replace generated claims.
	keys := map[string]bool{}
	for _, w := range writes {
		key := w.Kind + "\x00" + w.ID
		if keys[key] || w.Kind == "output-attribution-claims" || w.Kind == "entry-admission-bindings" {
			return nil, ErrConflict
		}
		keys[key] = true
		if w.Kind == TenantKind(expected.UserID, "output-attribution-intents") && w.ID == outputID {
			raw, e := json.Marshal(w.Value)
			if e != nil {
				return nil, e
			}
			var next outputAttributionIntent
			if json.Unmarshal(raw, &next) != nil || next.Revision != revision || next.State != "provisioning" {
				return nil, ErrConflict
			}
		}
	}
	generated := []RecordWrite{}
	for _, b := range bindings {
		if b.UserID != expected.UserID || b.OutputID != outputID || b.OutputRevision != revision || !expected.AllowsRoute(b.RouteID) {
			return nil, ErrConflict
		}
		record, e := EntryAdmissionBindingRecord(b)
		if e != nil {
			return nil, e
		}
		if keys[record.Kind+"\x00"+record.ID] {
			return nil, ErrConflict
		}
		keys[record.Kind+"\x00"+record.ID] = true
		// No legacy migration and no mutation of previously claimed principals.
		var old json.RawMessage
		if e = s.getTx(tx, record.Kind, record.ID, &old); e != ErrNotFound {
			if e == nil {
				return nil, ErrConflict
			}
			return nil, e
		}
		if e = s.getTx(tx, "output-attribution-claims", record.ID, &old); e != ErrNotFound {
			if e == nil {
				return nil, ErrConflict
			}
			return nil, e
		}
		var instance domain.CoreInstance
		if e = s.getTx(tx, "core-instances", b.InstanceID, &instance); e != nil {
			return nil, e
		}
		if instance.AdapterID != "routeweaver/managed-xray" {
			return nil, fmt.Errorf("attribution requires managed entry runtime")
		}
		var endpoint domain.ManagedEndpoint
		if e = s.getTx(tx, "managed-endpoints", b.EntryID, &endpoint); e != nil {
			return nil, e
		}
		if endpoint.InstanceID != b.InstanceID {
			return nil, ErrConflict
		}
		var g admissionGrant
		found := false
		for _, w := range writes {
			if w.Kind == TenantKind(b.UserID, "platform-entries") && w.ID == b.GrantID {
				raw, e := json.Marshal(w.Value)
				if e != nil {
					return nil, e
				}
				if e = json.Unmarshal(raw, &g); e != nil {
					return nil, e
				}
				found = true
			}
		}
		if !found {
			return nil, ErrConflict
		}
		if e = s.getTx(tx, TenantKind(b.UserID, "platform-entries"), b.GrantID, &old); e != ErrNotFound {
			if e == nil {
				return nil, ErrConflict
			}
			return nil, e
		}
		if g.Revoked || g.ID != b.GrantID || g.UserID != b.UserID || g.RouteID != b.RouteID || g.PublishedRouteID != b.RouteID || g.SubjectID != b.SubjectID || g.CredentialVersion != b.CredentialVersion || g.DeploymentID == "" || g.OutputID != outputID || g.OutputRevision != revision {
			return nil, ErrConflict
		}
		generated = append(generated, record, RecordWrite{Kind: "output-attribution-claims", ID: record.ID, Value: OutputAttributionClaim{Binding: b}})
	}
	return append(append([]RecordWrite{}, writes...), generated...), nil
}

// CompareServicePolicyAndGenerateRecords is the multi-instance equivalent of
// CompareServicePolicyAndGenerateRecord, including the final expiry recheck.
func (s *Store) CompareServicePolicyAndGenerateRecords(fence ServicePolicyFence, kind string, ids []string, compares []RecordCompare, sets []RecordSetCompare, build func(map[string]uint64) ([]RecordWrite, error)) (map[string]uint64, error) {
	return s.compareSetsAndGenerateRecords(kind, ids, compares, sets, build, &fence)
}

// CompareAttributedServicePolicyAndGenerateRecords commits attribution and
// every instance's desired generation in one transaction. Its callback is pure.
func (s *Store) CompareAttributedServicePolicyAndGenerateRecords(fence ServicePolicyFence, ownerPolicy service.EffectivePolicy, outputID, revision, kind string, ids []string, bindings []EntryAdmissionBinding, compares []RecordCompare, sets []RecordSetCompare, build func(map[string]uint64) ([]RecordWrite, error)) (map[string]uint64, error) {
	ownerFenced := false
	for _, c := range fence.Checks {
		if c.Policy.UserID == ownerPolicy.UserID {
			if !reflect.DeepEqual(c.Policy, ownerPolicy) {
				return nil, ErrConflict
			}
			routes := map[string]bool{}
			for _, r := range c.RouteIDs {
				routes[r] = true
			}
			for _, b := range bindings {
				if !routes[b.RouteID] {
					return nil, ErrConflict
				}
			}
			ownerFenced = true
		}
	}
	if !ownerFenced {
		return nil, ErrConflict
	}
	return s.compareSetsAndGenerateRecordsPrepared(kind, ids, compares, sets, build, &fence, func(tx *sql.Tx, writes []RecordWrite) ([]RecordWrite, error) {
		return s.prepareOutputAttributionWritesTx(tx, ownerPolicy, outputID, revision, bindings, writes)
	})
}
