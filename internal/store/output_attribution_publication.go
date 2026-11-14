package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"routeweaver/internal/domain"
	"strings"
)

type attributedOutputEnvelope struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	Token       string `json:"token"`
	TokenDigest string `json:"tokenDigest"`
}

// OutputAttributionQueueItem is a recovery pointer, not a cleanup receipt.
type OutputAttributionQueueItem struct {
	Owner    string `json:"owner"`
	OutputID string `json:"outputId"`
}

// OutputAttributionQueueRecord is pure. Reservation callers must validate IDs
// and commit this record with their reservation and queue-membership CAS.
func OutputAttributionQueueRecord(owner, outputID string) RecordWrite {
	sum := sha256.Sum256([]byte(owner + "\x00" + outputID))
	return RecordWrite{Kind: "output-attribution-queue", ID: hex.EncodeToString(sum[:]), Value: OutputAttributionQueueItem{Owner: owner, OutputID: outputID}}
}

// transitionOutputAttributionIntentTx preserves all lifecycle metadata. It is
// deliberately not a typed decode/re-encode of the coordinator's wider schema.
func (s *Store) transitionOutputAttributionIntentTx(tx *sql.Tx, owner, outputID, revision, next string, allowed ...string) error {
	var raw map[string]json.RawMessage
	if err := s.getTx(tx, TenantKind(owner, "output-attribution-intents"), outputID, &raw); err != nil {
		return err
	}
	var current outputAttributionIntent
	encoded, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(encoded, &current); err != nil {
		return err
	}
	if current.Revision != revision {
		return ErrConflict
	}
	ok := false
	for _, state := range allowed {
		ok = ok || current.State == state
	}
	if !ok {
		return ErrConflict
	}
	state, _ := json.Marshal(next)
	raw["state"] = state
	return s.putTx(tx, TenantKind(owner, "output-attribution-intents"), outputID, raw)
}

// CompareInputsAndPublishAttributedOutput is the final publication boundary.
// The caller must include exact applied-path and lifecycle evidence in compares;
// rendering alone is not such evidence. No feed token or published intent can
// become visible without its matching output in this one transaction.
func (s *Store) CompareInputsAndPublishAttributedOutput(fence ServicePolicyFence, owner, outputID, revision string, outputValue any, tokenDigest string, compares []RecordCompare, sets []RecordSetCompare) error {
	if !domain.ValidID(owner) || !domain.ValidID(outputID) || !domain.ValidID(revision) {
		return fmt.Errorf("valid output attribution identity required")
	}
	ownerFenced := false
	for _, check := range fence.Checks {
		if check.Policy.UserID == owner {
			ownerFenced = true
		}
	}
	if !ownerFenced {
		return ErrConflict
	}
	data, err := json.Marshal(outputValue)
	if err != nil {
		return err
	}
	var output attributedOutputEnvelope
	if err = json.Unmarshal(data, &output); err != nil {
		return err
	}
	sum := sha256.Sum256([]byte(output.Token))
	if output.ID != outputID || output.Status != "published" || output.Token == "" || tokenDigest != hex.EncodeToString(sum[:]) || output.TokenDigest != tokenDigest {
		return fmt.Errorf("complete published output and matching token required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	required := append([]RecordCompare{{Kind: TenantKind(owner, "outputs"), ID: outputID, Expected: nil}}, compares...)
	if err = s.compareRecordsTx(tx, required, sets); err != nil {
		return err
	}
	if err = s.checkServicePolicyFenceTx(tx, fence); err != nil {
		return err
	}
	if err = s.transitionOutputAttributionIntentTx(tx, owner, outputID, revision, "published", "provisioning"); err != nil {
		return err
	}
	if err = s.putTx(tx, TenantKind(owner, "outputs"), outputID, outputValue); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO token_index(kind,digest,record_id) VALUES(?,?,?)", "feeds", tokenDigest, owner+"/"+outputID); err != nil {
		return err
	}
	if err = s.releaseOutputAttributionLocksTx(tx, owner, outputID, revision, false); err != nil {
		return err
	}
	queue := OutputAttributionQueueRecord(owner, outputID)
	if _, err = s.deleteTx(tx, queue.Kind, queue.ID); err != nil {
		return err
	}
	if err = s.checkServicePolicyFenceTx(tx, fence); err != nil {
		return err
	}
	return tx.Commit()
}

// CompareInputsAndCancelAttributedOutput immediately removes the user's access
// and prevents new admission; the coordinator must subsequently compensate the
// fresh principal deployment. Claims and existing budget snapshots remain, so
// cancellation cannot erase already admitted traffic. expectedOutput=nil supports
// cancellation before publication without racing a concurrently published feed.
func (s *Store) CompareInputsAndCancelAttributedOutput(owner, outputID, revision string, expectedOutput any, compares []RecordCompare, sets []RecordSetCompare) error {
	if !domain.ValidID(owner) || !domain.ValidID(outputID) || !domain.ValidID(revision) {
		return fmt.Errorf("valid output attribution identity required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	required := append([]RecordCompare{{Kind: TenantKind(owner, "outputs"), ID: outputID, Expected: expectedOutput}}, compares...)
	if err = s.compareRecordsTx(tx, required, sets); err != nil {
		return err
	}
	if err = s.transitionOutputAttributionIntentTx(tx, owner, outputID, revision, "cancelling", "reserved", "provisioning", "published", "cancelling"); err != nil {
		return err
	}
	if _, err = s.deleteTx(tx, TenantKind(owner, "outputs"), outputID); err != nil {
		return err
	}
	// Scope deletion by the owned output, never by a caller-supplied token digest.
	if _, err = tx.Exec("DELETE FROM token_index WHERE kind=? AND record_id=?", "feeds", owner+"/"+outputID); err != nil {
		return err
	}
	queue := OutputAttributionQueueRecord(owner, outputID)
	if err = s.putTx(tx, queue.Kind, queue.ID, queue.Value); err != nil {
		return err
	}
	return tx.Commit()
}

// OutputAttributionQueueEntry is a bounded recovery cursor entry. A coordinator
// must re-read and compare the current intent before taking any action.
type OutputAttributionQueueEntry struct {
	Key string `json:"key"`
	OutputAttributionQueueItem
}

// ListOutputAttributionQueue reads at most limit encrypted recovery pointers.
// Keep the last returned Key as the cursor and reset it after a short/empty page.
// New entries behind a cursor are therefore picked up on the next sweep.
func (s *Store) ListOutputAttributionQueue(after string, limit int) ([]OutputAttributionQueueEntry, error) {
	if limit < 1 || limit > 100 {
		return nil, fmt.Errorf("queue page limit must be between 1 and 100")
	}
	if after != "" {
		if len(after) != 64 || after != strings.ToLower(after) {
			return nil, fmt.Errorf("invalid queue cursor")
		}
		if _, err := hex.DecodeString(after); err != nil {
			return nil, fmt.Errorf("invalid queue cursor")
		}
	}
	rows, err := s.db.Query(`SELECT id,CASE WHEN length(data)<=4096 THEN data ELSE NULL END FROM records WHERE kind='output-attribution-queue' AND id>? ORDER BY id LIMIT ?`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OutputAttributionQueueEntry{}
	for rows.Next() {
		var id string
		var encrypted []byte
		if err = rows.Scan(&id, &encrypted); err != nil {
			return nil, err
		}
		var item OutputAttributionQueueItem
		if err = s.open("output-attribution-queue", id, encrypted, &item); err != nil {
			return nil, err
		}
		if !domain.ValidID(item.Owner) || !domain.ValidID(item.OutputID) || OutputAttributionQueueRecord(item.Owner, item.OutputID).ID != id {
			return nil, fmt.Errorf("invalid recovery queue identity")
		}
		out = append(out, OutputAttributionQueueEntry{Key: id, OutputAttributionQueueItem: item})
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
