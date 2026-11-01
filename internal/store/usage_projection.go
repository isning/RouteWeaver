package store

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"routeweaver/internal/service"
	"time"
)

// usageWindow is entirely authenticated/encrypted, including its window identity.
// Decimal integers retain overflows so later canonical corrections can recover.
// There is exactly one row per account, not a historical-window cache.
type usageWindow struct {
	Version   int       `json:"version"`
	Start     time.Time `json:"start"`
	End       time.Time `json:"end"`
	Raw       string    `json:"raw"`
	Provider  string    `json:"provider"`
	Numerator string    `json:"numerator"`
}

// The SQL key exposes equality/row existence, not the logical account identity.
// It uses a separate PRF purpose from encryption; it is not a membership index.
func (s *Store) usageAccountToken(account string) (string, error) {
	if s.usageAEAD == nil || len(s.usageLookupKey) != sha256.Size {
		return "", errors.New("missing derived crypto context")
	}
	mac := hmac.New(sha256.New, s.usageLookupKey)
	mac.Write([]byte(account))
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func usageAAD(account string) []byte {
	out := []byte("routeweaver/usage-window/v1")
	out = binary.BigEndian.AppendUint64(out, uint64(len(account)))
	return append(out, []byte(account)...)
}

func (s *Store) readUsageWindowTx(tx *sql.Tx, account string) (*usageWindow, error) {
	token, err := s.usageAccountToken(account)
	if err != nil {
		return nil, err
	}
	var ciphertext []byte
	err = tx.QueryRow(`SELECT data FROM usage_windows WHERE account=?`, token).Scan(&ciphertext)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	n := s.usageAEAD.NonceSize()
	if len(ciphertext) < n {
		return nil, nil
	}
	plain, err := s.usageAEAD.Open(nil, ciphertext[:n], ciphertext[n:], usageAAD(account))
	if err != nil {
		return nil, nil
	} // Rebuildable corruption never implies zero usage.
	var w usageWindow
	if json.Unmarshal(plain, &w) != nil || w.Version != usageProjectionVersion {
		return nil, nil
	}
	if _, _, _, err = w.integers(); err != nil {
		return nil, nil
	}
	return &w, nil
}

func (s *Store) writeUsageWindowTx(tx *sql.Tx, account string, w *usageWindow) error {
	token, err := s.usageAccountToken(account)
	if err != nil {
		return err
	}
	plain, err := json.Marshal(w)
	if err != nil {
		return err
	}
	nonce := make([]byte, s.usageAEAD.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	ciphertext := s.usageAEAD.Seal(nonce, nonce, plain, usageAAD(account))
	_, err = tx.Exec(`INSERT INTO usage_windows(account,data) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET data=excluded.data`, token, ciphertext)
	return err
}

func exactUsageInteger(s string) (*big.Int, error) {
	n, ok := new(big.Int).SetString(s, 10)
	if !ok || n.Sign() < 0 || n.String() != s {
		return nil, errors.New("invalid exact usage total")
	}
	return n, nil
}
func (w *usageWindow) integers() (raw, provider, numerator *big.Int, err error) {
	if raw, err = exactUsageInteger(w.Raw); err != nil {
		return
	}
	if provider, err = exactUsageInteger(w.Provider); err != nil {
		return
	}
	numerator, err = exactUsageInteger(w.Numerator)
	return
}
func (w *usageWindow) totals() (service.UsageTotals, error) {
	raw, provider, numerator, err := w.integers()
	if err != nil {
		return service.UsageTotals{}, err
	}
	if !raw.IsInt64() || !provider.IsInt64() {
		return service.UsageTotals{}, errors.New("usage aggregate overflow")
	}
	out := service.UsageTotals{RawBytes: raw.Int64(), ProviderBytes: provider.Int64()}
	numerator.Add(numerator, big.NewInt(service.RateScale-1))
	numerator.Div(numerator, big.NewInt(service.RateScale))
	if !numerator.IsInt64() {
		return out, errors.New("weighted aggregate overflow")
	}
	out.WeightedBytes = numerator.Int64()
	return out, nil
}
func (w *usageWindow) includes(r *MeterRecord) bool {
	return !r.ObservedAt.Before(w.Start) && (w.End.IsZero() || r.ObservedAt.Before(w.End))
}
func validUsageContribution(r *MeterRecord) bool {
	return r.RawBytes >= 0 && r.ProviderBytes >= 0 && r.RateMicros >= 0
}
func (w *usageWindow) apply(r *MeterRecord, sign int64) error {
	if r == nil || !w.includes(r) {
		return nil
	}
	if !validUsageContribution(r) {
		return errors.New("invalid ledger usage contribution")
	}
	raw, provider, numerator, err := w.integers()
	if err != nil {
		return err
	}
	raw.Add(raw, new(big.Int).Mul(big.NewInt(r.RawBytes), big.NewInt(sign)))
	provider.Add(provider, new(big.Int).Mul(big.NewInt(r.ProviderBytes), big.NewInt(sign)))
	delta := new(big.Int).Mul(big.NewInt(r.RawBytes), big.NewInt(r.RateMicros))
	numerator.Add(numerator, delta.Mul(delta, big.NewInt(sign)))
	if raw.Sign() < 0 || provider.Sign() < 0 || numerator.Sign() < 0 {
		return errors.New("inconsistent derived usage total")
	}
	w.Raw, w.Provider, w.Numerator = raw.String(), provider.String(), numerator.String()
	return nil
}

func (s *Store) usageGenerationTx(tx *sql.Tx) (generation int64, clean bool, err error) {
	var version, current, acknowledged sql.NullInt64
	var triggers int
	// A missing marker is recoverable, but missing or changed trigger definitions
	// cannot authorize a clean read or acknowledgement: a bypassed writer may
	// already have changed canonical facts. Reopen reinstalls trusted definitions.
	err = tx.QueryRow(`SELECT
  (SELECT version FROM usage_projection_state WHERE id=1),
  (SELECT generation FROM usage_projection_state WHERE id=1),
  (SELECT acknowledged FROM usage_projection_state WHERE id=1),
  (SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND (
   (name='usage_ledger_insert' AND sql=?) OR
   (name='usage_ledger_update' AND sql=?) OR
   (name='usage_ledger_delete' AND sql=?)))`, usageLedgerInsertTrigger, usageLedgerUpdateTrigger, usageLedgerDeleteTrigger).Scan(&version, &current, &acknowledged, &triggers)
	if err != nil {
		return 0, false, err
	}
	if triggers != 3 {
		return 0, false, errors.New("usage projection triggers missing or changed; reopen store to rebuild derived state")
	}
	if !version.Valid || !current.Valid || !acknowledged.Valid {
		return 0, false, nil
	}
	return current.Int64, version.Int64 == usageProjectionVersion && current.Int64 >= 0 && current.Int64 == acknowledged.Int64, nil
}

// currentUsageTx runs only inside a reserved writer transaction. Historical Usage
// intentionally keeps its full canonical reducer as an independent public seam.
func (s *Store) currentUsageTx(tx *sql.Tx, account string, start, end time.Time) (service.UsageTotals, error) {
	_, clean, err := s.usageGenerationTx(tx)
	if err != nil {
		return service.UsageTotals{}, err
	}
	if !clean {
		if err = s.invalidateUsageTx(tx); err != nil {
			return service.UsageTotals{}, err
		}
	}
	w, err := s.readUsageWindowTx(tx, account)
	if err != nil {
		return service.UsageTotals{}, err
	}
	if w == nil || !w.Start.Equal(start) || !w.End.Equal(end) {
		w, err = s.rebuildUsageWindowTx(tx, account, start, end)
		if err != nil {
			return service.UsageTotals{}, err
		}
		if err = s.writeUsageWindowTx(tx, account, w); err != nil {
			return service.UsageTotals{}, err
		}
		if err = s.deleteUsageRebuildTx(tx, account); err != nil {
			return service.UsageTotals{}, err
		}
	}
	return w.totals()
}

// A cold rebuild streams the COMPLETE canonical ledger. Account membership is
// never inferred from IDs or an incomplete auxiliary index.
func (s *Store) rebuildUsageWindowTx(tx *sql.Tx, account string, start, end time.Time) (*usageWindow, error) {
	w := &usageWindow{Version: usageProjectionVersion, Start: start, End: end, Raw: "0", Provider: "0", Numerator: "0"}
	rows, err := tx.Query(`SELECT id,data FROM records WHERE kind='ledger' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var encrypted []byte
		if err = rows.Scan(&id, &encrypted); err != nil {
			return nil, err
		}
		var r MeterRecord
		if err = s.open("ledger", id, encrypted, &r); err != nil {
			return nil, err
		}
		if r.UserID == account {
			if err = w.apply(&r, 1); err != nil {
				return nil, err
			}
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return w, nil
}

// updateUsageWindowsTx applies old/new facts only to already complete windows.
// Missing/corrupt windows stay absent until a full rebuild, never zero + delta.
func (s *Store) updateUsageWindowsTx(tx *sql.Tx, old, next *MeterRecord) error {
	accounts := map[string]bool{}
	if old != nil {
		accounts[old.UserID] = true
	}
	if next != nil {
		accounts[next.UserID] = true
	}
	for account := range accounts {
		w, err := s.readUsageWindowTx(tx, account)
		if err != nil {
			return err
		}
		if w != nil {
			if old != nil && old.UserID == account {
				err = w.apply(old, -1)
			}
			if err == nil && next != nil && next.UserID == account {
				err = w.apply(next, 1)
			}
		}
		if w == nil || err != nil {
			// A failed derived subtraction indicates inconsistent state. Drop this row;
			// canonical facts remain authoritative and the next read reconstructs it.
			token, tokenErr := s.usageAccountToken(account)
			if tokenErr != nil {
				return tokenErr
			}
			if _, err = tx.Exec(`DELETE FROM usage_windows WHERE account=?`, token); err != nil {
				return err
			}
			continue
		}
		if err = s.writeUsageWindowTx(tx, account, w); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) acknowledgeUsageMutationTx(tx *sql.Tx, before int64) error {
	result, err := tx.Exec(`UPDATE usage_projection_state SET acknowledged=generation WHERE id=1 AND version=? AND generation=? AND acknowledged=?`, usageProjectionVersion, before+1, before)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return fmt.Errorf("usage generation changed unexpectedly")
	}
	return nil
}
