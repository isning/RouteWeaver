package store

import (
	"bytes"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"sort"
	"strings"
	"time"
)

var (
	ErrPolicyEditBaselineChanged      = fmt.Errorf("policy edit baseline changed: %w", ErrConflict)
	ErrPolicyEditPreconditionRequired = errors.New("policy edit precondition required")
	ErrPolicyEditUnsupportedRecord    = errors.New("saved policy contains unsupported fields or shape")
)

// ServicePolicyEditContext reads the actual saved record and its content token
// together. Missing records are explicit; a synthesized default is not a row.
func (s *Store) ServicePolicyEditContext(id string) (service.PolicyEditContext, error) {
	return s.policyEditContext(service.PolicyResourceTarget{Kind: "service", ID: id}, time.Time{})
}

// GroupPolicyEditContext protects full group edits without treating names or
// catalog positions as identity.
func (s *Store) GroupPolicyEditContext(id string) (service.PolicyEditContext, error) {
	return s.policyEditContext(service.PolicyResourceTarget{Kind: "group", ID: id}, time.Time{})
}

// EntitlementPolicyEditContext keeps actual row presence separate from the
// same-transaction effective projection. Reads never initialize an account cycle.
func (s *Store) EntitlementPolicyEditContext(userID string, now time.Time) (service.PolicyEditContext, error) {
	return s.policyEditContext(service.PolicyResourceTarget{Kind: "entitlement", ID: userID}, now)
}

func policyEditStorageKind(target service.PolicyResourceTarget) (string, error) {
	if !domain.ValidID(target.ID) {
		return "", fmt.Errorf("invalid %s id", target.Kind)
	}
	switch target.Kind {
	case "service":
		return "services", nil
	case "group":
		return "user-groups", nil
	case "entitlement":
		return "entitlements", nil
	default:
		return "", fmt.Errorf("unsupported policy edit target")
	}
}

func (s *Store) policyEditContext(target service.PolicyResourceTarget, now time.Time) (service.PolicyEditContext, error) {
	if _, err := policyEditStorageKind(target); err != nil {
		return service.PolicyEditContext{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return service.PolicyEditContext{}, err
	}
	defer tx.Rollback()
	out, err := s.policyEditContextTx(tx, target)
	if err != nil {
		return out, err
	}
	if target.Kind == "group" {
		labels, err := s.groupPolicyReferenceLabelsTx(tx, out.Record)
		if err != nil {
			return out, err
		}
		out.References = &labels
	}
	if target.Kind == "entitlement" {
		// This also requires a real subject user. Absence of an entitlement is
		// valid; absence of the user must never become a synthetic edit target.
		effective, err := s.effectivePolicyTx(tx, target.ID, now)
		if err != nil {
			return out, err
		}
		out.Effective = &effective
	}
	return out, nil
}

// Keep this core lookup unenriched: guarded preview must check the raw baseline
// before any fallible display-reference read can obscure its conflict response.
func (s *Store) policyEditContextTx(tx *sql.Tx, target service.PolicyResourceTarget) (service.PolicyEditContext, error) {
	out := service.PolicyEditContext{Target: target}
	kind, err := policyEditStorageKind(target)
	if err != nil {
		return out, err
	}
	var raw json.RawMessage
	err = s.getTx(tx, kind, target.ID, &raw)
	if err != nil && err != ErrNotFound {
		return out, err
	}
	if err == nil {
		var record service.PolicyChange
		var value any
		switch target.Kind {
		case "service":
			record.Service = &service.Plan{}
			value = record.Service
		case "group":
			record.Group = &service.Group{}
			value = record.Group
		case "entitlement":
			record.Entitlement = &service.Entitlement{}
			value = record.Entitlement
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(value); err != nil {
			return out, ErrPolicyEditUnsupportedRecord
		}
		var extra any
		actualTarget, targetErr := policyEditTarget(record)
		if decoder.Decode(&extra) != io.EOF || targetErr != nil || actualTarget != target {
			return out, ErrPolicyEditUnsupportedRecord
		}
		out.Record = &record
		out.Precondition.Exists = true
	}
	// Explicit presence plus complete raw logical content, not encryption bytes.
	// ReviewToken preserves JSON number precision and binds exact kind and ID.
	token, err := s.ReviewToken("policy-edit/v1/"+kind+"/"+target.ID, struct {
		Exists bool            `json:"exists"`
		Record json.RawMessage `json:"record"`
	}{out.Precondition.Exists, raw})
	if err != nil {
		return out, err
	}
	out.Precondition.Revision = token
	return out, nil
}

// Only names for this record's exact references are returned, never a mutable
// catalog. The caller owns the transaction and collects labels before simulation.
func (s *Store) groupPolicyReferenceLabelsTx(tx *sql.Tx, record *service.PolicyChange) (service.PolicyReferenceLabels, error) {
	out := service.PolicyReferenceLabels{Users: []service.PolicyReferenceLabel{}, Services: []service.PolicyReferenceLabel{}}
	if record == nil || record.Group == nil {
		return out, nil
	}
	group := record.Group
	for _, references := range []struct {
		kind   string
		ids    []string
		labels *[]service.PolicyReferenceLabel
	}{
		{"users", group.MemberIDs, &out.Users},
		{"services", []string{group.ServiceID}, &out.Services},
	} {
		seen := map[string]bool{}
		ids := []string{}
		for _, id := range references.ids {
			if id != "" && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			var raw json.RawMessage
			err := s.getTx(tx, references.kind, id, &raw)
			if err == ErrNotFound {
				continue
			}
			if err != nil {
				return out, err
			}
			// Display projection is not domain validation. An unusable name on
			// an old, removed reference must not block a valid replacement.
			// getTx above still propagates storage/decryption/invalid-JSON errors;
			// authoritative candidate and policy-snapshot validation is unchanged.
			var fields map[string]json.RawMessage
			if json.Unmarshal(raw, &fields) != nil {
				continue
			}
			var label service.PolicyReferenceLabel
			if json.Unmarshal(fields["id"], &label.ID) != nil || label.ID != id ||
				json.Unmarshal(fields["name"], &label.Name) != nil || strings.TrimSpace(label.Name) == "" {
				continue
			}
			*references.labels = append(*references.labels, label)
		}
	}
	return out, nil
}

// Resolve only exact record count/kind/ID, never candidate normalization or
// references. A stale draft must report its baseline conflict first.
func policyEditTarget(change service.PolicyChange) (service.PolicyResourceTarget, error) {
	var target service.PolicyResourceTarget
	count := 0
	if change.Service != nil {
		count++
		target = service.PolicyResourceTarget{Kind: "service", ID: change.Service.ID}
	}
	if change.Group != nil {
		count++
		target = service.PolicyResourceTarget{Kind: "group", ID: change.Group.ID}
	}
	if change.Entitlement != nil {
		count++
		target = service.PolicyResourceTarget{Kind: "entitlement", ID: change.Entitlement.UserID}
	}
	if count != 1 {
		return service.PolicyResourceTarget{}, fmt.Errorf("guarded editing supports exactly one service, group or entitlement")
	}
	_, err := policyEditStorageKind(target)
	return target, err
}

func checkPolicyEditPrecondition(expected, actual service.PolicyEditPrecondition) error {
	if expected.Revision == "" {
		return ErrPolicyEditPreconditionRequired
	}
	if expected.Exists != actual.Exists || len(expected.Revision) != len(actual.Revision) || subtle.ConstantTimeCompare([]byte(expected.Revision), []byte(actual.Revision)) != 1 {
		return ErrPolicyEditBaselineChanged
	}
	return nil
}

// PreviewPolicyEdit fences the opened policy record before any simulated
// write. Apply keeps the existing full-snapshot and exact-change ticket checks.
func (s *Store) PreviewPolicyEdit(change service.PolicyChange, expected service.PolicyEditPrecondition, now time.Time) (service.PolicyPreview, error) {
	if _, err := policyEditTarget(change); err != nil {
		return service.PolicyPreview{}, err
	}
	if expected.Revision == "" {
		return service.PolicyPreview{}, ErrPolicyEditPreconditionRequired
	}
	return s.policyChange(change, "", now, false, &expected)
}
