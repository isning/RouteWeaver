package store

import (
	"context"
	"database/sql"
	"routeweaver/internal/domain"
	"time"
)

// visitInsightLedgerWindowTx only reads authenticated canonical ledger records
// through the verified, bounded owner/time index. It never silently truncates or
// falls back to a whole-ledger scan. Callers choose their existing bucket logic.
func (s *Store) visitInsightLedgerWindowTx(ctx context.Context, tx *sql.Tx, user string, start, now time.Time, visit func(MeterRecord) error) error {
	var account domain.User
	if e := s.getTx(tx, "users", user, &account); e != nil {
		return e
	}
	generation, clean, e := s.usageGenerationTx(tx)
	if e != nil {
		return e
	}
	if !clean {
		return ErrInsightsUnavailable
	}
	valid, e := s.usageHistoryValidTx(ctx, tx, generation)
	if e != nil {
		return e
	}
	if !valid {
		return ErrInsightsUnavailable
	}
	var indexSQL string
	if e := tx.QueryRowContext(ctx, `SELECT sql FROM sqlite_schema WHERE type='index' AND name='usage_history_window'`).Scan(&indexSQL); e != nil || indexSQL != "CREATE INDEX usage_history_window ON usage_history(account,observed_second,id)" {
		return ErrInsightsUnavailable
	}
	token := s.usageHistoryToken(user)
	expected, found, valid, e := s.readUsageHistoryCountTx(ctx, tx, token)
	if e != nil {
		return e
	}
	if (!valid && found) || expected < 0 {
		return ErrInsightsUnavailable
	}
	rows, e := tx.QueryContext(ctx, `SELECT h.id,h.observed_second,CASE WHEN length(r.data)<=? THEN r.data ELSE NULL END FROM usage_history h INDEXED BY usage_history_window LEFT JOIN records r ON r.kind='ledger' AND r.id=h.id WHERE h.account=? AND h.observed_second>=? AND h.observed_second<=? ORDER BY h.observed_second,h.id LIMIT ?`, insightsRecordBytes, token, start.Unix(), now.Unix(), insightsRowLimit+1)
	if e != nil {
		return e
	}
	count := int64(0)
	readBytes := 0
	for rows.Next() {
		if e = ctx.Err(); e != nil {
			rows.Close()
			return e
		}
		count++
		if count > insightsRowLimit {
			rows.Close()
			return ErrInsightsUnavailable
		}
		var id string
		var raw []byte
		var record MeterRecord
		var observedSecond int64
		if e = rows.Scan(&id, &observedSecond, &raw); e != nil {
			rows.Close()
			return e
		}
		readBytes += len(raw)
		if readBytes > 8*1024*1024 {
			rows.Close()
			return ErrInsightsUnavailable
		}
		if e = s.open("ledger", id, raw, &record); e != nil {
			rows.Close()
			return ErrInsightsUnavailable
		}
		if record.UserID != user || record.ObservedAt.Unix() != observedSecond || !validUsageContribution(&record) || record.ObservedAt.IsZero() {
			rows.Close()
			return ErrInsightsUnavailable
		}
		if record.ObservedAt.After(now) {
			continue
		}
		if e = visit(record); e != nil {
			rows.Close()
			return e
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	if count > expected {
		return ErrInsightsUnavailable
	}

	return nil
}
