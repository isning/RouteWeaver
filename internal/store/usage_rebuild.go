package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
	"unicode/utf8"
)

// Partial state is physically distinct from complete usage windows. Old readers
// reject this derived table rather than treating partial totals as complete.
// Keep default work small enough to commit under the notification input deadline.
// The configured row/byte budget remains an upper bound, shared by the whole page.
const notificationRebuildChunkRows int64 = 1024
const notificationRebuildChunkBytes int64 = 1 << 20

type usageRebuild struct {
	Version  int         `json:"version"`
	Frontier *string     `json:"frontier,omitempty"`
	Window   usageWindow `json:"window"`
}

var ErrNotificationRebuildPending = errors.New("notification usage reconstruction is progressing in bounded steps; totals remain unknown until complete")

func usageRebuildAAD(account string) []byte {
	return append([]byte("routeweaver/usage-rebuild/v1\x00"), usageAAD(account)...)
}
func (s *Store) readUsageRebuildTx(tx *sql.Tx, account string) (*usageRebuild, error) {
	token, err := s.usageAccountToken(account)
	if err != nil {
		return nil, err
	}
	var raw []byte
	err = tx.QueryRow(`SELECT CASE WHEN length(data)<=1048576 THEN data ELSE NULL END FROM usage_rebuilds WHERE account=?`, token).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	n := s.usageAEAD.NonceSize()
	if len(raw) < n {
		return nil, nil
	}
	plain, err := s.usageAEAD.Open(nil, raw[:n], raw[n:], usageRebuildAAD(account))
	if err != nil {
		return nil, nil
	}
	var p usageRebuild
	if json.Unmarshal(plain, &p) != nil || p.Version != 1 || p.Window.Version != usageProjectionVersion {
		return nil, nil
	}
	if p.Frontier != nil && (len(*p.Frontier) > 4096 || !utf8.ValidString(*p.Frontier)) {
		return nil, nil
	}
	if _, _, _, err = p.Window.integers(); err != nil {
		return nil, nil
	}
	return &p, nil
}
func (s *Store) writeUsageRebuildTx(tx *sql.Tx, account string, p *usageRebuild) error {
	token, err := s.usageAccountToken(account)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if len(raw) > 1<<20-s.usageAEAD.NonceSize()-s.usageAEAD.Overhead() {
		return errors.New("usage rebuild state exceeds bound")
	}
	nonce := make([]byte, s.usageAEAD.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	sealed := s.usageAEAD.Seal(nonce, nonce, raw, usageRebuildAAD(account))
	_, err = tx.Exec(`INSERT INTO usage_rebuilds(account,data) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET data=excluded.data`, token, sealed)
	return err
}
func (s *Store) deleteUsageRebuildTx(tx *sql.Tx, account string) error {
	token, err := s.usageAccountToken(account)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`DELETE FROM usage_rebuilds WHERE account=?`, token)
	return err
}

// Every canonical mutation shares the SQLite writer transaction with this hook.
// Only already-scanned IDs contributed to partial sums; new/backdated IDs behind
// the frontier must contribute immediately, while unscanned IDs are read later.
func (s *Store) updateUsageRebuildsTx(tx *sql.Tx, id string, old, next *MeterRecord) error {
	accounts := map[string]bool{}
	if old != nil {
		accounts[old.UserID] = true
	}
	if next != nil {
		accounts[next.UserID] = true
	}
	for account := range accounts {
		p, err := s.readUsageRebuildTx(tx, account)
		if err != nil {
			return err
		}
		if p == nil {
			if err = s.deleteUsageRebuildTx(tx, account); err != nil {
				return err
			}
			continue
		}
		if p.Frontier == nil || id > *p.Frontier {
			continue
		}
		if old != nil && old.UserID == account {
			err = p.Window.apply(old, -1)
		}
		if err == nil && next != nil && next.UserID == account {
			err = p.Window.apply(next, 1)
		}
		if err != nil {
			if err = s.deleteUsageRebuildTx(tx, account); err != nil {
				return err
			}
			continue
		}
		if err = s.writeUsageRebuildTx(tx, account, p); err != nil {
			return err
		}
	}
	return nil
}

// A page shares one canonical prefix scan across one cold frontier group. Metadata is
// streamed before bodies, so no oversized ciphertext is allocated. The extra
// metadata row only establishes whether there is more work, never contributes.
func (s *Store) rebuildNotificationWindowsTx(ctx context.Context, tx *sql.Tx, windows map[string]*usageWindow, budget NotificationColdBudget) error {
	// Reserve half the remaining input deadline for encrypted checkpoint writes
	// and commit. This is a soft yield, never a substitute for cancellation.
	var yieldAt time.Time
	if deadline, ok := ctx.Deadline(); ok {
		yieldAt = time.Now().Add(time.Until(deadline) / 2)
	}
	budget.Rows = min(budget.Rows, notificationRebuildChunkRows)
	budget.Bytes = min(budget.Bytes, notificationRebuildChunkBytes)
	all := make(map[string]*usageRebuild, len(windows))
	var start *string
	for account, want := range windows {
		p, err := s.readUsageRebuildTx(tx, account)
		if err != nil {
			return err
		}
		if p == nil || !p.Window.Start.Equal(want.Start) || !p.Window.End.Equal(want.End) {
			p = &usageRebuild{Version: 1, Window: *want}
		}
		all[account] = p
		if p.Frontier != nil && (start == nil || *p.Frontier > *start) {
			start = p.Frontier
		}
	}
	// Finish the most advanced group first. A newly cold or repeatedly reset
	// peer cannot rewind a stable account's progress to the beginning forever.
	partials := make(map[string]*usageRebuild, len(all))
	for account, p := range all {
		if start == nil && p.Frontier == nil || start != nil && p.Frontier != nil && *start == *p.Frontier {
			partials[account] = p
		}
	}
	query := `SELECT substr(CAST(id AS BLOB),1,4097),length(CAST(id AS BLOB)),length(data) FROM records WHERE kind COLLATE BINARY='ledger'`
	args := []any{}
	if start != nil {
		query += ` AND id COLLATE BINARY>?`
		args = append(args, *start)
	}
	query += ` ORDER BY id COLLATE BINARY LIMIT ?`
	args = append(args, budget.Rows+1)
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	var count, total int64
	var end string
	complete := true
	for rows.Next() {
		if err = ctx.Err(); err != nil {
			break
		}
		var idBytes []byte
		var idSize, size int64
		if err = rows.Scan(&idBytes, &idSize, &size); err != nil {
			break
		}
		if count == budget.Rows {
			complete = false
			break
		}
		if size > notificationColdRecordBytes || size > budget.Bytes {
			err = ErrNotificationColdBudget
			break
		}
		id := string(idBytes)
		if !utf8.ValidString(id) || idSize > 4096 {
			err = errors.New("invalid canonical ledger identity")
			break
		}
		if size > budget.Bytes-total {
			complete = false
			break
		}
		count++
		total += size
		end = id
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	if count > 0 {
		query = `SELECT id,data FROM records WHERE kind COLLATE BINARY='ledger' AND id COLLATE BINARY<=?`
		args = []any{end}
		if start != nil {
			query += ` AND id COLLATE BINARY>?`
			args = append(args, *start)
		}
		query += ` ORDER BY id COLLATE BINARY`
		rows, err = tx.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		var consumed int64
		var consumedEnd string
		yielded := false
		for rows.Next() {
			if err = ctx.Err(); err != nil {
				break
			}
			var id string
			var raw []byte
			if err = rows.Scan(&id, &raw); err != nil {
				break
			}
			consumed++
			consumedEnd = id
			if consumed > count {
				err = errors.New("canonical ledger prefix changed during rebuild")
				break
			}
			var meter MeterRecord
			if err = s.open("ledger", id, raw, &meter); err != nil {
				break
			}
			if p := partials[meter.UserID]; p != nil && (p.Frontier == nil || id > *p.Frontier) {
				if err = p.Window.apply(&meter, 1); err != nil {
					break
				}
			}
			if !yieldAt.IsZero() && !time.Now().Before(yieldAt) {
				yielded = true
				complete = false
				break
			}
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return err
		}
		if yielded {
			end = consumedEnd
			count = consumed
		}
		if consumed != count {
			return errors.New("canonical ledger prefix incomplete")
		}
	}
	for account, p := range partials {
		if err = ctx.Err(); err != nil {
			return err
		}
		if complete {
			if err = s.writeUsageWindowTx(tx, account, &p.Window); err != nil {
				return err
			}
			if err = s.deleteUsageRebuildTx(tx, account); err != nil {
				return err
			}
			delete(windows, account)
		} else {
			if count == 0 {
				return ErrNotificationColdBudget
			}
			if p.Frontier == nil || *p.Frontier < end {
				cursor := end
				p.Frontier = &cursor
			}
			if err = s.writeUsageRebuildTx(tx, account, p); err != nil {
				return err
			}
		}
	}
	if len(windows) > 0 {
		return ErrNotificationRebuildPending
	}
	return nil
}
