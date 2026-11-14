package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"routeweaver/internal/diagnostics"
	"routeweaver/internal/domain"
	"time"
)

const rawCoreSettingsKind = "raw-core-log-settings"

func rawCoreDefaultSettings(id string) diagnostics.RawCoreSettings {
	return diagnostics.RawCoreSettings{InstanceID: id, RetentionSeconds: 3600, HistoryLimit: 128, LineBytesLimit: 4096}
}
func (s *Store) rawCoreSettingsTx(tx *sql.Tx, id string) (diagnostics.RawCoreSettings, error) {
	p := rawCoreDefaultSettings(id)
	e := s.getTx(tx, rawCoreSettingsKind, id, &p)
	if e == ErrNotFound {
		return rawCoreDefaultSettings(id), nil
	}
	if e != nil {
		return p, e
	}
	if p.InstanceID != id || !p.Valid() || p.Revision == "" {
		return p, diagnostics.ErrInvalid
	}
	return p, nil
}
func (s *Store) RawCoreSettings(id string) (diagnostics.RawCoreSettings, error) {
	p := rawCoreDefaultSettings(id)
	if !domain.ValidID(id) {
		return p, diagnostics.ErrInvalid
	}
	e := s.diagnosticTransaction(func(tx *sql.Tx) error {
		var i domain.CoreInstance
		if e := s.getTx(tx, "core-instances", id, &i); e != nil {
			return e
		}
		var e error
		p, e = s.rawCoreSettingsTx(tx, id)
		return e
	})
	return p, e
}
func (s *Store) AgentRawCoreSettings(scope domain.InstanceScope, now time.Time) (diagnostics.RawCoreSettings, error) {
	p := rawCoreDefaultSettings(scope.InstanceID)
	e := s.diagnosticTransaction(func(tx *sql.Tx) error {
		if e := s.diagnosticEnrollment(tx, scope, now); e != nil {
			return e
		}
		var e error
		p, e = s.rawCoreSettingsTx(tx, scope.InstanceID)
		return e
	})
	return p, e
}
func (s *Store) SetRawCoreSettings(id, expected string, enabled bool, retention int64) (diagnostics.RawCoreSettings, error) {
	p := rawCoreDefaultSettings(id)
	p.Enabled = enabled
	p.RetentionSeconds = retention
	if !domain.ValidID(id) || !p.Valid() {
		return p, diagnostics.ErrInvalid
	}
	e := s.diagnosticTransaction(func(tx *sql.Tx) error {
		var i domain.CoreInstance
		if e := s.getTx(tx, "core-instances", id, &i); e != nil {
			return e
		}
		old, e := s.rawCoreSettingsTx(tx, id)
		if e != nil {
			return e
		}
		if old.Revision != expected {
			return diagnostics.ErrRawCoreConflict
		}
		if old.Revision == "" {
			var count int
			if e = tx.QueryRow(`SELECT count(*) FROM records WHERE kind=?`, rawCoreSettingsKind).Scan(&count); e != nil {
				return e
			}
			if count >= diagnostics.RawCoreInstanceLimit {
				return diagnostics.ErrRawCoreCapacity
			}
		}
		b := make([]byte, 32)
		if _, e = rand.Read(b); e != nil {
			return e
		}
		p.Revision = hex.EncodeToString(b)
		if _, e = s.deleteTx(tx, rawCoreLogsKind, id); e != nil {
			return e
		}
		return s.putTx(tx, rawCoreSettingsKind, id, p)
	})
	return p, e
}
