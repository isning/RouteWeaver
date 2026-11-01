package store

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"os"
	"time"
)

var ErrInvalidCapacityLimits = errors.New("invalid capacity inventory limits")

// CapacityCount is exact unless AtLeast marks a bounded scan. Stored plaintext
// bytes are a pressure indicator, not the size of a serialized archive.
// It describes resource headroom, never authorization or accounting totals.
type CapacityCount struct {
	Count    int64 `json:"count"`
	Limit    int64 `json:"limit"`
	AtLeast  bool  `json:"atLeast"`
	Warning  bool  `json:"warning"`
	Exceeded bool  `json:"exceeded"`
}
type HistoryCapacity struct {
	NotificationRebuildChunkRows             int64         `json:"notificationRebuildChunkRows"`
	NotificationLargestLedgerCiphertextBytes CapacityCount `json:"notificationLargestLedgerCiphertextBytes"`
	BackupRecordPlaintextBytes               CapacityCount `json:"backupRecordPlaintextBytes"`
	BackupLargestRecordBytes                 CapacityCount `json:"backupLargestRecordBytes"`
	CheckedAt                                time.Time     `json:"checkedAt"`
	BackupRows                               CapacityCount `json:"backupRows"`
	NotificationLedgerRows                   CapacityCount `json:"notificationLedgerRows"`
	NotificationLedgerCiphertextBytes        CapacityCount `json:"notificationLedgerCiphertextBytes"`
	ArchiveByteLimit                         int64         `json:"archiveByteLimit"`
	ArchiveBytes                             *int64        `json:"archiveBytes"` // Unknown without complete archive creation.
	DatabaseFileBytes                        *int64        `json:"databaseFileBytes"`
	FilesystemAvailableBytes                 *uint64       `json:"filesystemAvailableBytes"`
	WarningPercent                           int           `json:"warningPercent"`
}

func capacityCount(count, limit int64, atLeast bool) CapacityCount {
	return CapacityCount{Count: count, Limit: limit, AtLeast: atLeast, Warning: count >= limit-limit/5, Exceeded: count > limit}
}

// HistoryCapacityInventory bounds metadata visits to configured backup rows+1
// plus notification rows+1. No canonical plaintext, IDs or host paths escape.
// Separate file/free-space observations are not an atomic disk-capacity promise.
func (s *Store) HistoryCapacityInventory(ctx context.Context, limits BackupLimits) (out HistoryCapacity, err error) {
	if !limits.valid() {
		return out, ErrInvalidCapacityLimits
	}
	out.ArchiveByteLimit = limits.MaxBytes
	out.WarningPercent = 80
	out.NotificationRebuildChunkRows = notificationRebuildChunkRows
	err = s.readSnapshot(ctx, func(tx *sql.Tx) error {
		if e := validateBackupSchema(ctx, tx); e != nil {
			return e
		}
		if e := validateMigrationVersions(ctx, tx); e != nil {
			return e
		}
		var n, total, largest int64
		if e := tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(n),0),coalesce(max(n),0) FROM (
   SELECT max(0,length(data)-?) AS n FROM records UNION ALL SELECT 0 FROM identities UNION ALL
   SELECT 0 FROM token_index UNION ALL SELECT 0 FROM counters UNION ALL
   SELECT 0 FROM schema_migrations LIMIT ?
  )`, s.aead.NonceSize()+s.aead.Overhead(), limits.MaxRows+1).Scan(&n, &total, &largest); e != nil {
			return e
		}
		out.BackupRecordPlaintextBytes = capacityCount(total, limits.MaxBytes, n > int64(limits.MaxRows))
		out.BackupLargestRecordBytes = capacityCount(largest, int64(limits.MaxRecordBytes), n > int64(limits.MaxRows))

		out.BackupRows = capacityCount(n, int64(limits.MaxRows), n > int64(limits.MaxRows))
		var ledgerBytes, largestLedger int64
		if e := tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(n),0),coalesce(max(n),0) FROM (SELECT length(data) AS n FROM records WHERE kind='ledger' ORDER BY id LIMIT ?)`, notificationColdRows+1).Scan(&n, &ledgerBytes, &largestLedger); e != nil {
			return e
		}
		out.NotificationLargestLedgerCiphertextBytes = capacityCount(largestLedger, notificationColdRecordBytes, n > notificationColdRows)
		out.NotificationLedgerRows = capacityCount(n, notificationColdRows, n > notificationColdRows)
		out.NotificationLedgerCiphertextBytes = capacityCount(ledgerBytes, notificationColdBytes, n > notificationColdRows)
		return nil
	})
	if err != nil {
		return HistoryCapacity{}, err
	}
	var path string
	if e := s.db.QueryRowContext(ctx, `SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); e != nil {
		return HistoryCapacity{}, e
	}
	var allocated int64
	known := true
	for _, suffix := range []string{"", "-wal", "-shm"} {
		info, e := os.Stat(path + suffix)
		if e != nil {
			if suffix != "" && os.IsNotExist(e) {
				continue
			}
			known = false
			break
		}
		if info.Size() < 0 || info.Size() > math.MaxInt64-allocated {
			known = false
			break
		}
		allocated += info.Size()
	}
	if known {
		out.DatabaseFileBytes = &allocated
	}
	out.FilesystemAvailableBytes = historyAvailableBytes(path)
	out.CheckedAt = time.Now().UTC()
	return out, nil
}
