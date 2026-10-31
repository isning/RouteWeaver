package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/notifications"
	"routeweaver/internal/service"
	"time"
)

const NotificationPageSize = 100
const notificationColdRows = 1000000
const notificationColdBytes = 512 << 20
const notificationColdRecordBytes = 1 << 20

// NotificationColdBudget bounds metadata and ciphertext visited during one
// cold rebuild. Callers may lower these limits, never exceed the reviewed maxima.
type NotificationColdBudget struct {
	Rows  int64
	Bytes int64
}

func DefaultNotificationColdBudget() NotificationColdBudget {
	return NotificationColdBudget{notificationColdRows, notificationColdBytes}
}
func (b NotificationColdBudget) Validate() error {
	if b.Rows < 1 || b.Rows > notificationColdRows || b.Bytes < 1 || b.Bytes > notificationColdBytes {
		return errors.New("notification cold budget must be 1–1000000 rows and 1–536870912 bytes")
	}
	return nil
}

var ErrNotificationColdBudget = errors.New("notification usage projection requires a cold rebuild exceeding the bounded worker budget")

type NotificationPage struct {
	Recipients []notifications.Recipient
	Users      []notifications.UserSnapshot
	Next       string
}

// NotificationInputPage uses keyset rotation over current users, not historical
// events/meters. Usage is the same committed immutable cycle-window projection
// used by admission, not a changing end=now snapshot that rebuilds every tick.
// Missing windows for this page share ONE bounded canonical rebuild pass.
func (s *Store) NotificationInputPage(ctx context.Context, after string, limit int, now time.Time) (page NotificationPage, err error) {
	return s.NotificationInputPageWithBudget(ctx, after, limit, now, DefaultNotificationColdBudget())
}
func (s *Store) NotificationInputPageWithBudget(ctx context.Context, after string, limit int, now time.Time, budget NotificationColdBudget) (page NotificationPage, err error) {
	if err = budget.Validate(); err != nil {
		return page, err
	}
	if limit < 1 || limit > NotificationPageSize {
		return page, fmt.Errorf("notification page size must be 1–100")
	}
	if err = s.lockNotificationContext(ctx); err != nil {
		return page, err
	}
	defer s.mu.Unlock()
	tx, err := s.beginNotificationWriteTx(ctx)
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,data FROM records WHERE kind='users' AND id>? ORDER BY id LIMIT ?`, after, limit+1)
	if err != nil {
		return page, err
	}
	users := []domain.User{}
	last := ""
	more := false
	for rows.Next() {
		var id string
		var b []byte
		if err = rows.Scan(&id, &b); err != nil {
			break
		}
		if len(users) == limit {
			more = true
			break
		}
		var user domain.User
		if err = s.open("users", id, b, &user); err != nil {
			break
		}
		users = append(users, user)
		last = id
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return page, err
	}
	if more {
		page.Next = last
	}
	if after == "" {
		page.Recipients = append(page.Recipients, notifications.Recipient{ID: "operator", Role: "admin", Enabled: true})
	}
	windows := map[string]*usageWindow{}
	policies := map[string]service.EffectivePolicy{}
	for _, user := range users {
		if err = ctx.Err(); err != nil {
			return page, err
		}
		recipient, e := s.notificationRecipientTx(tx, user)
		if e != nil {
			return page, e
		}
		page.Recipients = append(page.Recipients, recipient)
	}
	for _, user := range users {
		enabled := false
		for _, r := range page.Recipients {
			if r.ID == user.ID {
				enabled = r.Enabled
				break
			}
		}
		if !enabled {
			continue
		}
		policy, e := s.effectivePolicyTx(tx, user.ID, now)
		if e != nil {
			return page, e
		}
		policies[user.ID] = policy
		cycle, e := policy.Entitlement.Cycle.Window(now)
		if e != nil {
			return page, e
		}
		end := time.Time{}
		if cycle.NextReset != nil {
			end = *cycle.NextReset
		}
		windows[user.ID] = &usageWindow{Version: usageProjectionVersion, Start: cycle.Start, End: end, Raw: "0", Provider: "0", Numerator: "0"}
	}
	if len(windows) == 0 {
		return page, tx.Commit()
	}
	// Reset history is streamed once per bounded page; no historical allocation.
	rows, err = tx.QueryContext(ctx, `SELECT id,data FROM records WHERE kind='resets' ORDER BY id`)
	if err != nil {
		return page, err
	}
	for rows.Next() {
		if err = ctx.Err(); err != nil {
			break
		}
		var id string
		var b []byte
		if err = rows.Scan(&id, &b); err != nil {
			break
		}
		var reset Reset
		if err = s.open("resets", id, b, &reset); err != nil {
			break
		}
		if w := windows[reset.UserID]; w != nil && reset.At.After(w.Start) && !reset.At.After(now) {
			w.Start = reset.At
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return page, err
	}
	_, clean, err := s.usageGenerationTx(tx)
	if err != nil {
		return page, err
	}
	if !clean {
		if err = s.invalidateUsageTx(tx); err != nil {
			return page, err
		}
	}
	cold := map[string]*usageWindow{}
	for id, want := range windows {
		have, e := s.readUsageWindowTx(tx, id)
		if e != nil {
			return page, e
		}
		if have == nil || !have.Start.Equal(want.Start) || !have.End.Equal(want.End) {
			cold[id] = want
		}
	}
	var coldErr error
	if len(cold) > 0 {
		if err = s.rebuildNotificationWindowsTx(ctx, tx, cold, budget); err != nil {
			if !errors.Is(err, ErrNotificationColdBudget) {
				return page, err
			}
			if !clean {
				// Roll back invalidation/acknowledgement. These explicitly
				// usage-unknown snapshots contain only policy/expiry facts.
				if rollbackErr := tx.Rollback(); rollbackErr != nil {
					return page, errors.Join(err, rollbackErr)
				}
				for _, user := range users {
					if w := windows[user.ID]; w != nil {
						p := policies[user.ID]
						page.Users = append(page.Users, notifications.UserSnapshot{UserID: user.ID, Enabled: true, UsageUnknown: true, QuotaBytes: p.QuotaBytes, CycleID: w.Start.UTC().Format(time.RFC3339Nano), ExpiresAt: p.Entitlement.ExpiresAt})
					}
				}
				return page, err
			}
			coldErr = err
			// Existing verified warm accounts still receive reminders. A new
			// cold account must not suppress the other accounts in its page.
			for id := range cold {
				delete(windows, id)
			}
		}
	}
	snapshots := []notifications.UserSnapshot{}
	for _, user := range users {
		window := windows[user.ID]
		if window == nil {
			if coldErr != nil {
				if w := cold[user.ID]; w != nil {
					p := policies[user.ID]
					snapshots = append(snapshots, notifications.UserSnapshot{UserID: user.ID, Enabled: true, UsageUnknown: true, QuotaBytes: p.QuotaBytes, CycleID: w.Start.UTC().Format(time.RFC3339Nano), ExpiresAt: p.Entitlement.ExpiresAt})
				}
			}
			continue
		}
		if err = ctx.Err(); err != nil {
			return page, err
		}
		totals, e := s.currentUsageTx(tx, user.ID, window.Start, window.End)
		if e != nil {
			return page, e
		}
		policy := policies[user.ID]
		snapshots = append(snapshots, notifications.UserSnapshot{UserID: user.ID, Enabled: true, QuotaBytes: policy.QuotaBytes, UsedBytes: totals.WeightedBytes, CycleID: window.Start.UTC().Format(time.RFC3339Nano), ExpiresAt: policy.Entitlement.ExpiresAt})
	}
	if err = tx.Commit(); err != nil {
		page.Users = nil
		return page, err
	}
	page.Users = snapshots
	return page, coldErr
}
func (s *Store) rebuildNotificationWindowsTx(ctx context.Context, tx *sql.Tx, windows map[string]*usageWindow, budget NotificationColdBudget) error {
	var count, total, largest int64
	if err := tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(bytes),0),coalesce(max(bytes),0) FROM (SELECT length(data) AS bytes FROM records WHERE kind='ledger' ORDER BY id LIMIT ?)`, budget.Rows+1).Scan(&count, &total, &largest); err != nil {
		return err
	}
	if count > budget.Rows || total > budget.Bytes || largest > notificationColdRecordBytes {
		return ErrNotificationColdBudget
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,data FROM records WHERE kind='ledger' ORDER BY id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		if err = ctx.Err(); err != nil {
			break
		}
		var id string
		var b []byte
		if err = rows.Scan(&id, &b); err != nil {
			break
		}
		var meter MeterRecord
		if err = s.open("ledger", id, b, &meter); err != nil {
			break
		}
		if w := windows[meter.UserID]; w != nil {
			if err = w.apply(&meter, 1); err != nil {
				break
			}
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	for id, w := range windows {
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = s.writeUsageWindowTx(tx, id, w); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) notificationRecipientTx(tx *sql.Tx, user domain.User) (notifications.Recipient, error) {
	r := notifications.Recipient{ID: user.ID, Role: "user", Enabled: user.Enabled}
	var account Account
	if err := s.getTx(tx, "accounts", user.ID, &account); err == nil {
		r.Role = account.Role
		r.Enabled = r.Enabled && !account.Disabled && !account.Retired
	} else if err != ErrNotFound {
		return r, err
	}
	return r, nil
}

// NotificationRecipients enumerates current identity only, never ledger/history.
// Dispatch needs the whole current audience: using the evaluation page alone
// would incorrectly cancel other recipients' pending deliveries.
func (s *Store) NotificationRecipients(ctx context.Context) ([]notifications.Recipient, error) {
	if err := s.lockNotificationContext(ctx); err != nil {
		return nil, err
	}
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	out := []notifications.Recipient{{ID: "operator", Role: "admin", Enabled: true}}
	rows, err := tx.QueryContext(ctx, `SELECT id,data FROM records WHERE kind='users' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		var id string
		var b []byte
		if err = rows.Scan(&id, &b); err != nil {
			return nil, err
		}
		var user domain.User
		if err = s.open("users", id, b, &user); err != nil {
			return nil, err
		}
		r, e := s.notificationRecipientTx(tx, user)
		if e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// NotificationInputs is a compatibility aggregate for offline callers/tests.
// Production uses one NotificationInputPage per worker tick, never this method.
func (s *Store) NotificationInputs(now time.Time) ([]notifications.Recipient, []notifications.UserSnapshot, error) {
	recipients := []notifications.Recipient{}
	users := []notifications.UserSnapshot{}
	after := ""
	for {
		page, err := s.NotificationInputPage(context.Background(), after, NotificationPageSize, now)
		if err != nil {
			return nil, nil, err
		}
		recipients = append(recipients, page.Recipients...)
		users = append(users, page.Users...)
		if page.Next == "" {
			break
		}
		after = page.Next
	}
	return recipients, users, nil
}
