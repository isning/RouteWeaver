package store

import (
	"database/sql"
	"math"
	"math/big"
	"reflect"
	"time"
)

const quotaCoverageDuration = 7 * 24 * time.Hour

// Incremental, bounded per-account projection: no seven-day full-budget scan and
// no per-connection history duplication. Only issuance, byte changes and final
// receipts update the small checkpoint; zero-byte ongoing renewals do not.
func (s *Store) prepareQuotaBudgetMutationTx(tx *sql.Tx, id string, next []byte) ([]quotaCoverageCheckpoint, error) {
	var active bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM records WHERE kind=?)`, quotaCoverageKind).Scan(&active); err != nil {
		return nil, err
	}
	if !active {
		return nil, nil
	}
	var old, nextBudget admissionBudget
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
	if next != nil && s.open("admission-budgets", id, next, &nextBudget) != nil {
		return []quotaCoverageCheckpoint{{Invalid: true}}, nil
	}
	accounts := map[string]bool{}
	if old.AccountID != "" {
		accounts[old.AccountID] = true
	}
	if nextBudget.AccountID != "" {
		accounts[nextBudget.AccountID] = true
	}
	out := []quotaCoverageCheckpoint{}
	for account := range accounts {
		c, found, err := s.readQuotaCheckpointTx(tx, account)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		if c.Invalid || c.Version != 1 || c.StartedAt.IsZero() {
			continue
		}
		end := c.StartedAt.Add(quotaCoverageDuration)
		bad := next == nil || nextBudget.AccountID != account || nextBudget.Coverage == nil || nextBudget.Coverage.Version != 1 || nextBudget.Coverage.ClockUncertain
		if oldErr == nil && old.Closed && reflect.DeepEqual(old, nextBudget) {
			continue
		}
		// Budgets issued after the closed window cannot contribute to it. A late
		// mutation of an older budget is still checked below, not silently ignored.
		if !bad && !nextBudget.IssuedAt.Before(end) && (oldErr == ErrNotFound || !old.IssuedAt.Before(end)) {
			continue
		}
		if !bad && (nextBudget.IssuedAt.Before(c.StartedAt) || !nextBudget.IssuedAt.Equal(nextBudget.Coverage.StartedAt)) {
			bad = true
		}
		if !bad && oldErr == nil && (old.AccountID != nextBudget.AccountID || old.RouteID != nextBudget.RouteID || old.Rate != nextBudget.Rate || !old.IssuedAt.Equal(nextBudget.IssuedAt) || nextBudget.SettledRaw < old.SettledRaw || old.Closed) {
			bad = true
		}
		if !bad && nextBudget.Closed && (nextBudget.Coverage.FinalSource != "agent" || nextBudget.Coverage.FinalReceivedAt == nil || nextBudget.Coverage.FinalReceivedAt.Before(nextBudget.IssuedAt) || nextBudget.Coverage.FinalReceivedAt.After(end)) {
			bad = true
		}
		changed := false
		if !bad && oldErr == ErrNotFound {
			if c.Issued == math.MaxUint64 {
				bad = true
			} else {
				c.Issued++
				changed = true
			}
		}
		if !bad && nextBudget.Closed && (oldErr == ErrNotFound || !old.Closed) {
			if c.Closed == math.MaxUint64 {
				bad = true
			} else {
				c.Closed++
				changed = true
			}
		}
		var before uint64
		if oldErr == nil {
			before = old.SettledRaw
		}
		if !bad && nextBudget.SettledRaw != before {
			delta := nextBudget.SettledRaw - before
			total, ok := new(big.Int).SetString(c.WeightedNumerator, 10)
			if !ok || total.Sign() < 0 || nextBudget.Rate.Micros < 0 || math.MaxUint64-c.RawBytes < delta {
				bad = true
			} else {
				total.Add(total, new(big.Int).Mul(new(big.Int).SetUint64(delta), big.NewInt(nextBudget.Rate.Micros)))
				if total.BitLen() > 128 {
					bad = true
				} else {
					c.WeightedNumerator = total.String()
					c.RawBytes += delta
					changed = true
				}
			}
		}
		if bad {
			c.Invalid = true
			c.StartedAt = time.Time{}
			if c.Generation < math.MaxUint64 {
				c.Generation++
			}
			changed = true
		}
		if changed {
			out = append(out, c)
		}
	}
	return out, nil
}
