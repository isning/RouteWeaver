package store

import (
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
)

// Binding record builders are pure. An application transaction creating a grant
// and its bindings together must separately fence authoritative inventory,
// account, grant/version and deployment inputs and require new binding absence.
// They do not authorize caller-supplied references or perform database writes.
func EntryAdmissionBindingRecord(v EntryAdmissionBinding) (RecordWrite, error) {
	for _, id := range []string{v.ID, v.InstanceID, v.EntryID, v.SubjectID, v.UserID, v.RouteID, v.GrantID, v.CredentialVersion} {
		if !domain.ValidID(id) {
			return RecordWrite{}, fmt.Errorf("valid explicit entry binding identities required")
		}
	}
	return RecordWrite{Kind: "entry-admission-bindings", ID: admissionBindingKey(v.InstanceID, v.EntryID, v.SubjectID, v.CredentialVersion), Value: v}, nil
}
func MeterBindingRecord(v MeterBinding) (RecordWrite, error) {
	for _, id := range []string{v.ID, v.InstanceID, v.SubjectID, v.UserID, v.RouteID, v.PolicyRevision, v.CycleID} {
		if !domain.ValidID(id) {
			return RecordWrite{}, fmt.Errorf("binding requires explicit valid identities")
		}
	}
	if v.MeasurementLayer != "entry_payload" && v.MeasurementLayer != entrypolicy.MeasurementLayer && v.MeasurementLayer != "provider_in_out" {
		return RecordWrite{}, fmt.Errorf("unsupported measurement layer")
	}
	if v.LedgerMode != "" && v.LedgerMode != "counter" && v.LedgerMode != "admission-budget" {
		return RecordWrite{}, fmt.Errorf("unsupported ledger mode")
	}
	if v.LedgerMode == "admission-budget" && v.MeasurementLayer != entrypolicy.MeasurementLayer {
		return RecordWrite{}, fmt.Errorf("budget ledger mode is only for verified managed entry payload")
	}
	return RecordWrite{Kind: "meter-bindings", ID: bindingKey(v), Value: v}, nil
}
