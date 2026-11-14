package store

import (
	"database/sql"
	"math"
	"math/big"
	"reflect"
	"time"
)

const quotaCoverageDuration = 7 * 24 * time.Hour

type quotaObservationWindow struct {
	Start             time.Time `json:"start"`
	End               time.Time `json:"end"`
	Issued            uint64    `json:"issued,string"`
	Closed            uint64    `json:"closed,string"`
	RawBytes          uint64    `json:"rawBytes,string"`
	WeightedNumerator string    `json:"weightedNumerator"`
	Invalid           bool      `json:"invalid"`
}

func (c *quotaCoverageCheckpoint) startQuotaWindow(at time.Time) bool {
	if c.Open != 0 || at.Before(c.StartedAt) || !c.LastWindowStart.IsZero() && at.Sub(c.LastWindowStart) < 24*time.Hour {
		return false
	}
	c.Windows = append(c.Windows, quotaObservationWindow{Start: at, End: at.Add(quotaCoverageDuration), WeightedNumerator: "0"})
	c.LastWindowStart = at
	c.trimQuotaWindows(at)
	return true
}
func (c *quotaCoverageCheckpoint) trimQuotaWindows(at time.Time) {
	keep := c.Windows[:0]
	for _, w := range c.Windows {
		if !w.End.Before(at.Add(-24 * time.Hour)) {
			keep = append(keep, w)
		}
	}
	c.Windows = keep
	if len(c.Windows) > 9 {
		c.Windows = c.Windows[len(c.Windows)-9:]
	}
}
func (c *quotaCoverageCheckpoint) invalidateQuota() {
	c.Invalid = true
	c.StartedAt = time.Time{}
	if c.Generation < math.MaxUint64 {
		c.Generation++
	}
}

// No duplicate per-connection history: at most nine overlapping windows share
// one encrypted account row. Windows start only at a known zero-open boundary.
// Issuance/final/changed bytes update it; zero-byte ordinary renewals do not.
func (s *Store) prepareQuotaBudgetMutationTx(tx *sql.Tx, id string, next []byte) ([]quotaCoverageCheckpoint, error) {
	var active bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM records WHERE kind=?)`, quotaCoverageKind).Scan(&active); err != nil {
		return nil, err
	}
	if !active {
		return nil, nil
	}
	var old, b admissionBudget
	var prior []byte
	oldErr := tx.QueryRow(`SELECT data FROM records WHERE kind='admission-budgets' AND id=?`, id).Scan(&prior)
	if oldErr == sql.ErrNoRows {
		oldErr = ErrNotFound
	} else if oldErr != nil {
		return nil, oldErr
	}
	if prior != nil && s.open("admission-budgets", id, prior, &old) != nil {
		return []quotaCoverageCheckpoint{{Invalid: true}}, nil
	}
	if next != nil && s.open("admission-budgets", id, next, &b) != nil {
		return []quotaCoverageCheckpoint{{Invalid: true}}, nil
	}
	accounts := map[string]bool{}
	if old.AccountID != "" {
		accounts[old.AccountID] = true
	}
	if b.AccountID != "" {
		accounts[b.AccountID] = true
	}
	out := []quotaCoverageCheckpoint{}
	for account := range accounts {
		c, found, err := s.readQuotaCheckpointTx(tx, account)
		if err != nil {
			return nil, err
		}
		if !found || c.Invalid || c.StartedAt.IsZero() {
			continue
		}
		if oldErr == nil && old.Closed && reflect.DeepEqual(old, b) {
			continue
		}
		bad := next == nil || b.AccountID != account || b.Coverage == nil || b.Coverage.Version != 1 || b.Coverage.ClockUncertain || b.IssuedAt.Before(c.StartedAt)
		at := b.IssuedAt
		if !bad {
			if !b.Coverage.StartedAt.Equal(b.IssuedAt) {
				bad = true
			}
			if b.Coverage.LastReceiptAt != nil {
				at = *b.Coverage.LastReceiptAt
			}
			if at.Before(b.IssuedAt) || at.Before(c.LastEventAt) {
				bad = true
			}
		}
		if !bad && oldErr == nil && (old.AccountID != b.AccountID || old.RouteID != b.RouteID || old.Rate != b.Rate || !old.IssuedAt.Equal(b.IssuedAt) || b.SettledRaw < old.SettledRaw || old.Closed) {
			bad = true
		}
		if !bad && b.Closed && (b.Coverage.FinalSource != "agent" || b.Coverage.FinalReceivedAt == nil || !b.Coverage.FinalReceivedAt.Equal(at)) {
			bad = true
		}
		created := oldErr == ErrNotFound
		closed := b.Closed && (created || !old.Closed)
		before := uint64(0)
		if !created {
			before = old.SettledRaw
		}
		changed := created || closed || b.SettledRaw != before
		if !bad && !changed {
			continue
		}
		if !bad && created {
			c.startQuotaWindow(at)
			if c.Open == math.MaxUint64 {
				bad = true
			} else {
				c.Open++
			}
		}
		if !bad && closed {
			if c.Open == 0 {
				bad = true
			} else {
				c.Open--
			}
		}
		if !bad {
			for i := range c.Windows {
				w := &c.Windows[i]
				if w.Invalid || b.IssuedAt.Before(w.Start) || !b.IssuedAt.Before(w.End) {
					continue
				}
				if created {
					if w.Issued == math.MaxUint64 {
						bad = true
						break
					}
					w.Issued++
				}
				if closed {
					if at.After(w.End) {
						w.Invalid = true
						continue
					}
					if w.Closed == math.MaxUint64 {
						bad = true
						break
					}
					w.Closed++
				}
				if b.SettledRaw != before {
					delta := b.SettledRaw - before
					n, ok := new(big.Int).SetString(w.WeightedNumerator, 10)
					if !ok || n.Sign() < 0 || b.Rate.Micros < 0 || math.MaxUint64-w.RawBytes < delta {
						bad = true
						break
					}
					n.Add(n, new(big.Int).Mul(new(big.Int).SetUint64(delta), big.NewInt(b.Rate.Micros)))
					if n.BitLen() > 128 {
						bad = true
						break
					}
					w.RawBytes += delta
					w.WeightedNumerator = n.String()
				}
			}
		}
		if bad {
			c.invalidateQuota()
		} else {
			c.LastEventAt = at
			c.trimQuotaWindows(at)
			if closed {
				c.startQuotaWindow(at)
			}
		}
		out = append(out, c)
	}
	return out, nil
}
