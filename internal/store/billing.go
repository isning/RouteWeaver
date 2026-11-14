package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"time"
)

type MeterBatch struct {
	UserID        string    `json:"userId"`
	RouteID       string    `json:"routeId"`
	MeterID       string    `json:"meterId"`
	Epoch         string    `json:"epoch"`
	Sequence      uint64    `json:"sequence"`
	RawBytes      int64     `json:"rawBytes"`
	ProviderBytes int64     `json:"providerBytes"`
	ObservedAt    time.Time `json:"observedAt"`
}
type MeterRecord struct {
	OutputID       string `json:"outputId,omitempty"`
	OutputRevision string `json:"outputRevision,omitempty"`
	BudgetID       string `json:"budgetId,omitempty"`
	MeterBatch
	IntervalStart time.Time `json:"intervalStart,omitzero"`
	IntervalEnd   time.Time `json:"intervalEnd,omitzero"`
	WeightedBytes int64     `json:"weightedBytes"`
	RateID        string    `json:"rateId"`
	RateMicros    int64     `json:"rateMicros"`
	RecordedAt    time.Time `json:"recordedAt"`
}
type Reset struct {
	ID     string    `json:"id"`
	UserID string    `json:"userId"`
	At     time.Time `json:"at"`
	Reason string    `json:"reason"`
}

func (s *Store) SetRate(v service.Rate) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !domain.ValidID(v.ID) || !domain.ValidID(v.RouteID) || v.Micros < 0 || v.Micros > 1000*service.RateScale || v.EffectiveAt.IsZero() {
		return fmt.Errorf("invalid rate revision")
	}
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); e != nil {
		return e
	}
	var old service.Rate
	if e = s.getTx(tx, "rates", v.ID, &old); e == nil {
		return fmt.Errorf("rate revisions are immutable")
	} else if e != ErrNotFound {
		return e
	}
	all, e := s.listTx(tx, "rates")
	if e != nil {
		return e
	}
	for _, raw := range all {
		var rate service.Rate
		if e = json.Unmarshal(raw, &rate); e != nil {
			return e
		}
		if rate.RouteID == v.RouteID && rate.EffectiveAt.Equal(v.EffectiveAt) {
			return fmt.Errorf("duplicate effective boundary")
		}
	}
	budgets, e := s.listTx(tx, "admission-budgets")
	if e != nil {
		return e
	}
	for _, raw := range budgets {
		var budget admissionBudget
		if e = json.Unmarshal(raw, &budget); e != nil {
			return e
		}
		if !budget.Closed && budget.RouteID == v.RouteID && v.EffectiveAt.Before(budget.ExpiresAt) {
			return fmt.Errorf("rate boundary overlaps an issued byte budget; schedule after its expiry or settle active presences first")
		}
	}
	if e = s.putTx(tx, "rates", v.ID, v); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) Rates() ([]service.Rate, error) {
	raw, e := s.List("rates")
	out := []service.Rate{}
	for _, b := range raw {
		var v service.Rate
		if e := json.Unmarshal(b, &v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, e
}
func (s *Store) RecordMeter(m MeterBatch) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !domain.ValidID(m.UserID) || !domain.ValidID(m.RouteID) || !domain.ValidID(m.MeterID) || !domain.ValidID(m.Epoch) || m.Sequence == 0 || m.RawBytes < 0 || m.ProviderBytes < 0 || m.ObservedAt.IsZero() || m.ObservedAt.After(time.Now().Add(5*time.Minute)) {
		return fmt.Errorf("invalid measured usage")
	}
	tx, e := s.beginWriteTx()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var u domain.User
	if e := s.getTx(tx, "users", m.UserID, &u); e != nil {
		return e
	}
	key := fmt.Sprintf("%s:%s:%s:%d", m.UserID, m.MeterID, m.Epoch, m.Sequence)
	var old MeterRecord
	if e := s.getTx(tx, "ledger", key, &old); e == nil {
		a, _ := json.Marshal(m)
		b, _ := json.Marshal(old.MeterBatch)
		if string(a) != string(b) {
			return fmt.Errorf("conflicting meter replay")
		}
		return nil
	} else if e != ErrNotFound {
		return e
	}
	rate := service.Rate{ID: "default-1x", Micros: service.RateScale}
	all, e := s.listTx(tx, "rates")
	if e != nil {
		return e
	}
	for _, b := range all {
		var r service.Rate
		if e = json.Unmarshal(b, &r); e != nil {
			return e
		}
		if r.RouteID == m.RouteID && !r.EffectiveAt.After(m.ObservedAt) && r.EffectiveAt.After(rate.EffectiveAt) {
			rate = r
		}
	}
	weighted, e := service.WeightedBytes(m.RawBytes, rate.Micros)
	if e != nil {
		return e
	}
	if e = s.putTx(tx, "ledger", key, MeterRecord{MeterBatch: m, WeightedBytes: weighted, RateID: rate.ID, RateMicros: rate.Micros, RecordedAt: time.Now().UTC()}); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) Usage(user string, start, end time.Time) (service.UsageTotals, error) {
	return s.UsageContext(context.Background(), user, start, end)
}

// UsageContext reduces complete owner history in a single read snapshot, using
// authenticated derived membership when valid and otherwise scanning canonical
// history. Both paths use O(maximum record) memory and the same exact reducer.
// It never substitutes the future-inclusive current-cycle projection.
func (s *Store) UsageContext(ctx context.Context, user string, start, end time.Time) (totals service.UsageTotals, err error) {
	err = s.readSnapshot(ctx, func(tx *sql.Tx) error {
		if indexed, usable, indexErr := s.indexedUsageTx(ctx, tx, user, start, end); indexErr == nil && usable {
			totals = indexed
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rows, e := tx.QueryContext(ctx, `SELECT id,data FROM records WHERE kind='ledger' ORDER BY id`)
		if e != nil {
			return e
		}
		defer rows.Close()
		totals, e = reduceUsageRecords(func(r *MeterRecord) (bool, error) {
			if !rows.Next() {
				return false, rows.Err()
			}
			var id string
			var data []byte
			if e := rows.Scan(&id, &data); e != nil {
				return false, e
			}
			if e := s.open("ledger", id, data, r); e != nil {
				return false, e
			}
			return true, nil
		}, user, start, end)
		return e
	})
	if err != nil {
		return service.UsageTotals{}, err
	}
	return totals, nil
}
func aggregateUsageRecords(raw []json.RawMessage, user string, start, end time.Time) (service.UsageTotals, error) {
	i := 0
	return reduceUsageRecords(func(r *MeterRecord) (bool, error) {
		if i == len(raw) {
			return false, nil
		}
		b := raw[i]
		i++
		return true, json.Unmarshal(b, r)
	}, user, start, end)
}
func reduceUsageRecords(next func(*MeterRecord) (bool, error), user string, start, end time.Time) (service.UsageTotals, error) {
	v := service.UsageTotals{}
	weightedMicros := new(big.Int)
	for {
		var r MeterRecord
		more, e := next(&r)
		if e != nil {
			return v, e
		}
		if !more {
			break
		}
		if r.UserID != user || r.ObservedAt.Before(start) || !end.IsZero() && !r.ObservedAt.Before(end) {
			continue
		}
		if r.RawBytes > math.MaxInt64-v.RawBytes || r.ProviderBytes > math.MaxInt64-v.ProviderBytes {
			return v, fmt.Errorf("usage aggregate overflow")
		}
		v.RawBytes += r.RawBytes
		weightedMicros.Add(weightedMicros, new(big.Int).Mul(big.NewInt(r.RawBytes), big.NewInt(r.RateMicros)))
		v.ProviderBytes += r.ProviderBytes
	}
	weightedMicros.Add(weightedMicros, big.NewInt(service.RateScale-1))
	weightedMicros.Div(weightedMicros, big.NewInt(service.RateScale))
	if !weightedMicros.IsInt64() {
		return v, fmt.Errorf("weighted aggregate overflow")
	}
	v.WeightedBytes = weightedMicros.Int64()
	return v, nil
}
func (s *Store) ManualReset(user, reason string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if reason == "" || at.IsZero() {
		return fmt.Errorf("reset reason and time required")
	}
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`UPDATE counters SET value=value WHERE kind='admission-lock'`); e != nil {
		return e
	}
	var u domain.User
	if e = s.getTx(tx, "users", user, &u); e != nil {
		return e
	}
	budgets, e := s.listTx(tx, "admission-budgets")
	if e != nil {
		return e
	}
	for _, raw := range budgets {
		var budget admissionBudget
		if e = json.Unmarshal(raw, &budget); e != nil {
			return e
		}
		if !budget.Closed && budget.AccountID == user && (!budget.Finite || budget.GrantedRaw > budget.SettledRaw) {
			return fmt.Errorf("settle active or unresolved byte budgets before a manual reset")
		}
	}
	id := fmt.Sprintf("%s:%d", user, at.UnixNano())
	if e = s.putTx(tx, "resets", id, Reset{ID: fmt.Sprintf("%d", at.UnixNano()), UserID: user, Reason: reason, At: at}); e != nil {
		return e
	}
	return tx.Commit()
}
func (s *Store) LastReset(user string, after, before time.Time) (time.Time, error) {
	raw, e := s.List("resets")
	latest := after
	for _, b := range raw {
		var r Reset
		if e := json.Unmarshal(b, &r); e != nil {
			return latest, e
		}
		if r.UserID == user && r.At.After(latest) && !r.At.After(before) {
			latest = r.At
		}
	}
	return latest, e
}
