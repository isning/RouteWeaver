package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

var ErrAdmissionEvidence = errors.New("admitted byte report conflicts with reservation evidence; retained for accounting review")

type AdmissionAnomaly struct {
	ID         string                `json:"id"`
	Scope      AdmissionScope        `json:"scope"`
	Binding    EntryAdmissionBinding `json:"binding"`
	LeaseID    string                `json:"leaseId"`
	Request    AdmissionRequest      `json:"request"`
	Reason     string                `json:"reason"`
	RecordedAt time.Time             `json:"recordedAt"`
}

func (s *Store) recordAdmissionAnomaly(tx *sql.Tx, scope AdmissionScope, binding EntryAdmissionBinding, leaseID string, in AdmissionRequest, now time.Time) error {
	raw, _ := json.Marshal(struct {
		Scope   AdmissionScope
		Request AdmissionRequest
	}{scope, in})
	digest := sha256.Sum256(raw)
	id := "admission:" + hex.EncodeToString(digest[:])
	value := AdmissionAnomaly{ID: id, Scope: scope, Binding: binding, LeaseID: leaseID, Request: in, Reason: ErrAdmissionEvidence.Error(), RecordedAt: now}
	var prior AdmissionAnomaly
	if e := s.getTx(tx, "admission-anomalies", id, &prior); e == ErrNotFound {
		if e = s.putTx(tx, "admission-anomalies", id, value); e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	return s.putTx(tx, "accounting-holds", binding.UserID+":"+id, AccountingHold{UserID: binding.UserID, ReceiptID: id, Reason: value.Reason, CreatedAt: now})
}
