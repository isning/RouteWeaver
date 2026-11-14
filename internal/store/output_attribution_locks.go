package store

import (
	"database/sql"
	"routeweaver/internal/domain"
	"sort"
)

type attributionProvisioningLock struct {
	Owner          string `json:"owner"`
	OutputID       string `json:"outputId"`
	OutputRevision string `json:"outputRevision"`
	MigrationID    string `json:"migrationId"`
}
type attributionMigrationReceipt struct {
	ID                string `json:"id"`
	Owner             string `json:"owner"`
	OutputID          string `json:"outputId"`
	OutputRevision    string `json:"outputRevision"`
	DeploymentID      string `json:"deploymentId"`
	State             string `json:"state"`
	SourceMigrationID string `json:"sourceMigrationId"`
}

// releaseOutputAttributionLocksTx only releases the exact lock belonging to each
// original migration. Timeouts do not transfer lock ownership. Cancellation may
// have no lock only when no original migration was ever queued.
func (s *Store) releaseOutputAttributionLocksTx(tx *sql.Tx, owner, outputID, revision string, cancelled bool) error {
	var intent struct {
		MigrationIDs map[string]string `json:"migrationIds"`
	}
	if err := s.getTx(tx, TenantKind(owner, "output-attribution-intents"), outputID, &intent); err != nil {
		return err
	}
	if len(intent.MigrationIDs) > 100 || (!cancelled && len(intent.MigrationIDs) == 0) {
		return ErrConflict
	}
	deployments := []string{}
	for dep := range intent.MigrationIDs {
		deployments = append(deployments, dep)
	}
	sort.Strings(deployments)
	for _, dep := range deployments {
		id := intent.MigrationIDs[dep]
		if !domain.ValidID(dep) || !domain.ValidID(id) {
			return ErrConflict
		}
		var receipt attributionMigrationReceipt
		receiptErr := s.getTx(tx, "principal-service-migrations", id, &receipt)
		if receiptErr != nil && receiptErr != ErrNotFound {
			return receiptErr
		}
		var lock attributionProvisioningLock
		lockErr := s.getTx(tx, "principal-provisioning-locks", dep, &lock)
		if lockErr != nil && lockErr != ErrNotFound {
			return lockErr
		}
		if cancelled && receiptErr == ErrNotFound {
			// This intent never queued a migration. Another intent's lock is
			// unrelated; leave it untouched and do not wait for its work.
			if lockErr == ErrNotFound || lock.Owner != owner || lock.OutputID != outputID || lock.OutputRevision != revision {
				continue
			}
			// An owned lock without its atomically-created receipt is corrupt.
			return ErrConflict
		}
		if receiptErr != nil || lockErr != nil {
			return ErrConflict
		}
		want := attributionProvisioningLock{Owner: owner, OutputID: outputID, OutputRevision: revision, MigrationID: id}
		if lock != want || receipt.ID != id || receipt.Owner != owner || receipt.OutputID != outputID || receipt.OutputRevision != revision || receipt.DeploymentID != dep || receipt.SourceMigrationID != "" {
			return ErrConflict
		}
		state := "applied"
		if cancelled {
			state = "compensated"
		}
		if receipt.State != state {
			return ErrConflict
		}
		if _, err := s.deleteTx(tx, "principal-provisioning-locks", dep); err != nil {
			return err
		}
	}
	return nil
}

// CompareInputsAndFinishAttributedCancellation is only the terminal database
// step after every original migration's compensation has been confirmed. It
// cannot treat a queued rollback or an expired lock as completed cleanup.
func (s *Store) CompareInputsAndFinishAttributedCancellation(owner, outputID, revision string, compares []RecordCompare, sets []RecordSetCompare) error {
	if !domain.ValidID(owner) || !domain.ValidID(outputID) || !domain.ValidID(revision) {
		return ErrConflict
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
	if err = s.transitionOutputAttributionIntentTx(tx, owner, outputID, revision, "cancelled", "cancelling"); err != nil {
		return err
	}
	if err = s.releaseOutputAttributionLocksTx(tx, owner, outputID, revision, true); err != nil {
		return err
	}
	queue := OutputAttributionQueueRecord(owner, outputID)
	if _, err = s.deleteTx(tx, queue.Kind, queue.ID); err != nil {
		return err
	}
	return tx.Commit()
}
