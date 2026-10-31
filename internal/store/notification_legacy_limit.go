package store

import (
	"database/sql"
	"errors"
)

const MaxLegacyNotificationBytes = 64 << 20
const MaxOfflineLegacyNotificationBytes = 256 << 20

var ErrLegacyNotificationLimit = errors.New("legacy notification state exceeds automatic migration memory limit; migrate an offline snapshot with the notification-migrate tool")

type notificationLengthReader interface{ QueryRow(string, ...any) *sql.Row }

func (s *Store) checkLegacyNotificationSize(q notificationLengthReader) error {
	var exists int
	if err := q.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='records'`).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return nil
	}
	var size int64
	err := q.QueryRow(`SELECT length(data) FROM records WHERE kind='notification-private' AND id='state'`).Scan(&size)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	limit := s.notificationMigrationLimit
	if limit == 0 {
		limit = MaxLegacyNotificationBytes
	}
	if size > limit+int64(s.aead.NonceSize()+s.aead.Overhead()) {
		return ErrLegacyNotificationLimit
	}
	return nil
}
