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
	"math"
	"routeweaver/internal/service"
	"time"
)

// Only current obligations are retained here. Canonical history is never removed.
// Equality/existence, encrypted size and write patterns remain observable in SQL;
// account identities, IPs, expiry, rates and amounts do not.
type admissionLiveWindow struct {
	Version     int                        `json:"version"`
	Account     string                     `json:"account"`
	Watermark   time.Time                  `json:"watermark"`
	Leases      map[string]admissionLease  `json:"leases"`
	Budgets     map[string]admissionBudget `json:"budgets"`
	Expired     uint64                     `json:"expired"`
	Exceptional bool                       `json:"exceptional"`
}

func (s *Store) admissionLiveKey(d admissionLiveDomain, account string, marker bool) (string, []byte, error) {
	if s.liveAEAD[d] == nil || len(s.liveLookupKey[d]) != 32 {
		return "", nil, errors.New("missing derived admission crypto context")
	}
	aad := []byte("routeweaver/admission-" + string(d) + "/v1")
	if marker {
		return "", append(aad, 0), nil
	}
	aad = append(aad, 1)
	aad = binary.BigEndian.AppendUint64(aad, uint64(len(account)))
	aad = append(aad, account...)
	mac := hmac.New(sha256.New, s.liveLookupKey[d])
	mac.Write([]byte(account))
	return hex.EncodeToString(mac.Sum(nil)), aad, nil
}
func (s *Store) readAdmissionLiveRowTx(tx *sql.Tx, d admissionLiveDomain, account string, marker bool) (*admissionLiveWindow, error) {
	token, aad, err := s.admissionLiveKey(d, account, marker)
	if err != nil {
		return nil, err
	}
	var data []byte
	err = tx.QueryRow(`SELECT data FROM `+d.rowsTable()+` WHERE account=?`, token).Scan(&data)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	aead := s.liveAEAD[d]
	n := aead.NonceSize()
	if len(data) < n {
		return nil, nil
	}
	plain, err := aead.Open(nil, data[:n], data[n:], aad)
	if err != nil {
		return nil, nil
	}
	var w admissionLiveWindow
	if json.Unmarshal(plain, &w) != nil || w.Version != 1 || w.Account != account {
		return nil, nil
	}
	if !marker && ((d == leaseLive && w.Leases == nil) || (d == budgetLive && w.Budgets == nil)) {
		return nil, nil
	}
	return &w, nil
}
func (s *Store) writeAdmissionLiveRowTx(tx *sql.Tx, d admissionLiveDomain, account string, marker bool, w *admissionLiveWindow) error {
	token, aad, err := s.admissionLiveKey(d, account, marker)
	if err != nil {
		return err
	}
	plain, err := json.Marshal(w)
	if err != nil {
		return err
	}
	aead := s.liveAEAD[d]
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	data := aead.Seal(nonce, nonce, plain, aad)
	_, err = tx.Exec(`INSERT INTO `+d.rowsTable()+`(account,data) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET data=excluded.data`, token, data)
	return err
}
func (s *Store) markAdmissionExceptionalTx(tx *sql.Tx, d admissionLiveDomain) error {
	if _, err := tx.Exec(`DELETE FROM ` + d.rowsTable()); err != nil {
		return err
	}
	return s.writeAdmissionLiveRowTx(tx, d, "", true, &admissionLiveWindow{Version: 1, Exceptional: true})
}

// Decode failures and arithmetic anomalies are never new canonical write errors.
// They force the original ordered evaluator, including its pending/error precedence.
func decodeAdmissionLive(d admissionLiveDomain, raw json.RawMessage) (*admissionLease, *admissionBudget, bool) {
	if d == leaseLive {
		var v admissionLease
		if json.Unmarshal(raw, &v) != nil {
			return nil, nil, false
		}
		return &v, nil, true
	}
	var v admissionBudget
	if json.Unmarshal(raw, &v) != nil {
		return nil, nil, false
	}
	if !v.Closed && v.Finite && v.GrantedRaw != v.SettledRaw {
		if v.GrantedRaw < v.SettledRaw {
			return nil, nil, false
		}
		outstanding := v.GrantedRaw - v.SettledRaw
		if outstanding > math.MaxInt64 {
			return nil, nil, false
		}
		if _, err := service.WeightedBytes(int64(outstanding), v.Rate.Micros); err != nil {
			return nil, nil, false
		}
	}
	return nil, &v, true
}
func relevantAdmissionBudget(v *admissionBudget) bool {
	return v != nil && !v.Closed && (!v.Finite || v.GrantedRaw > v.SettledRaw)
}
func (w *admissionLiveWindow) apply(id string, lease *admissionLease, budget *admissionBudget, add bool) error {
	if lease != nil {
		if lease.Binding.UserID != w.Account || !w.Watermark.Before(lease.ExpiresAt) {
			return nil
		}
		if add {
			w.Leases[id] = *lease
		} else {
			if _, ok := w.Leases[id]; !ok {
				return errors.New("missing derived lease")
			}
			delete(w.Leases, id)
		}
	}
	if budget != nil && budget.AccountID == w.Account && relevantAdmissionBudget(budget) {
		if w.Watermark.Before(budget.ExpiresAt) {
			if add {
				w.Budgets[id] = *budget
			} else {
				if _, ok := w.Budgets[id]; !ok {
					return errors.New("missing derived budget")
				}
				delete(w.Budgets, id)
			}
		} else if add {
			if w.Expired == math.MaxUint64 {
				return errors.New("expired budget overflow")
			}
			w.Expired++
		} else {
			if w.Expired == 0 {
				return errors.New("expired budget underflow")
			}
			w.Expired--
		}
	}
	return nil
}

// listAdmissionCanonicalTx preserves listTx's authenticate-all/raw-validate-all
// stage and canonical ID ordering while retaining the IDs needed by the cache.
func (s *Store) listAdmissionCanonicalTx(tx *sql.Tx, d admissionLiveDomain) ([]string, []json.RawMessage, error) {
	rows, err := tx.Query(`SELECT id,data FROM records WHERE kind=? ORDER BY id`, d.kind())
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	ids := []string{}
	values := []json.RawMessage{}
	for rows.Next() {
		var id string
		var data []byte
		if err = rows.Scan(&id, &data); err != nil {
			return nil, nil, err
		}
		var raw json.RawMessage
		if err = s.open(d.kind(), id, data, &raw); err != nil {
			return nil, nil, err
		}
		ids = append(ids, id)
		values = append(values, raw)
	}
	return ids, values, rows.Err()
}
func (s *Store) admissionLiveWindowTx(tx *sql.Tx, d admissionLiveDomain, account string, now time.Time) (*admissionLiveWindow, error) {
	_, clean, err := s.admissionLiveGenerationTx(tx, d)
	if err != nil {
		return nil, err
	}
	marker, err := s.readAdmissionLiveRowTx(tx, d, "", true)
	if err != nil {
		return nil, err
	}
	if !clean || marker == nil {
		if err = s.invalidateAdmissionLiveTx(tx, d); err != nil {
			return nil, err
		}
		marker = &admissionLiveWindow{}
	}
	// Exceptional markers are cleared only by complete canonical proof. Staying
	// on fallback until a mutation dirties the domain is deliberately conservative.
	if marker.Exceptional {
		return nil, nil
	}
	w, err := s.readAdmissionLiveRowTx(tx, d, account, false)
	if err != nil {
		return nil, err
	}
	if w == nil || now.Before(w.Watermark) {
		ids, raws, err := s.listAdmissionCanonicalTx(tx, d)
		if err != nil {
			return nil, err
		}
		w = &admissionLiveWindow{Version: 1, Account: account, Watermark: now, Leases: map[string]admissionLease{}, Budgets: map[string]admissionBudget{}}
		for i, raw := range raws {
			lease, budget, ok := decodeAdmissionLive(d, raw)
			if !ok {
				if err = s.markAdmissionExceptionalTx(tx, d); err != nil {
					return nil, err
				}
				return nil, nil
			}
			if err = w.apply(ids[i], lease, budget, true); err != nil {
				return nil, err
			}
		}
	} else {
		for id, v := range w.Leases {
			if !now.Before(v.ExpiresAt) {
				delete(w.Leases, id)
			}
		}
		for id, v := range w.Budgets {
			if !now.Before(v.ExpiresAt) {
				if w.Expired == math.MaxUint64 {
					return nil, errors.New("expired budget overflow")
				}
				w.Expired++
				delete(w.Budgets, id)
			}
		}
		w.Watermark = now
	}
	if err = s.writeAdmissionLiveRowTx(tx, d, account, false, w); err != nil {
		return nil, err
	}
	return w, nil
}

// A mutation carries old/new canonical facts only within its reserved transaction.
// Absent account projections remain absent: a delta cannot establish completeness.
type admissionLiveMutation struct {
	domain                admissionLiveDomain
	generation            int64
	clean, representable  bool
	oldLease, nextLease   *admissionLease
	oldBudget, nextBudget *admissionBudget
}

func (s *Store) prepareAdmissionLiveMutationTx(tx *sql.Tx, kind, id string, next []byte) (*admissionLiveMutation, error) {
	d := liveDomainForKind(kind)
	if d == "" {
		return nil, nil
	}
	m := &admissionLiveMutation{domain: d, representable: true}
	var err error
	m.generation, m.clean, err = s.admissionLiveGenerationTx(tx, d)
	if err != nil {
		return nil, err
	}
	marker, err := s.readAdmissionLiveRowTx(tx, d, "", true)
	if err != nil {
		return nil, err
	}
	if marker == nil || marker.Exceptional {
		m.clean = false
	}
	if !m.clean {
		return m, nil
	}
	var raw json.RawMessage
	err = s.getTx(tx, kind, id, &raw)
	if err == nil {
		m.oldLease, m.oldBudget, m.representable = decodeAdmissionLive(d, raw)
	} else if err != ErrNotFound {
		m.representable = false
	}
	if next != nil {
		var raw json.RawMessage
		if s.open(kind, id, next, &raw) != nil {
			m.representable = false
		} else {
			l, b, ok := decodeAdmissionLive(d, raw)
			m.nextLease, m.nextBudget = l, b
			m.representable = m.representable && ok
		}
	}
	return m, nil
}
func (s *Store) finishAdmissionLiveMutationTx(tx *sql.Tx, id string, m *admissionLiveMutation) error {
	if m == nil || !m.clean {
		return nil
	}
	if !m.representable {
		if err := s.markAdmissionExceptionalTx(tx, m.domain); err != nil {
			return err
		}
		return s.acknowledgeAdmissionLiveTx(tx, m.domain, m.generation)
	}
	accounts := map[string]bool{}
	for _, v := range []*admissionLease{m.oldLease, m.nextLease} {
		if v != nil {
			accounts[v.Binding.UserID] = true
		}
	}
	for _, v := range []*admissionBudget{m.oldBudget, m.nextBudget} {
		if v != nil {
			accounts[v.AccountID] = true
		}
	}
	for account := range accounts {
		w, err := s.readAdmissionLiveRowTx(tx, m.domain, account, false)
		if err != nil {
			return err
		}
		if w != nil {
			err = w.apply(id, m.oldLease, m.oldBudget, false)
			if err == nil {
				err = w.apply(id, m.nextLease, m.nextBudget, true)
			}
		}
		if w == nil || err != nil {
			token, _, err := s.admissionLiveKey(m.domain, account, false)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(`DELETE FROM `+m.domain.rowsTable()+` WHERE account=?`, token); err != nil {
				return err
			}
			continue
		}
		if err = s.writeAdmissionLiveRowTx(tx, m.domain, account, false, w); err != nil {
			return err
		}
	}
	return s.acknowledgeAdmissionLiveTx(tx, m.domain, m.generation)
}

func (s *Store) admissionLivePresencesTx(tx *sql.Tx, account string, now time.Time) (map[string]bool, int, error) {
	w, err := s.admissionLiveWindowTx(tx, leaseLive, account, now)
	if err != nil {
		return nil, 0, err
	}
	ips := map[string]bool{}
	count := 0
	if w != nil {
		for _, v := range w.Leases {
			ips[v.ClientIP] = true
			count++
		}
		return ips, count, nil
	}
	all, err := s.listTx(tx, "entry-admission-leases")
	if err != nil {
		return nil, 0, err
	}
	for _, raw := range all {
		var v admissionLease
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, 0, err
		}
		if v.Binding.UserID == account && now.Before(v.ExpiresAt) {
			ips[v.ClientIP] = true
			count++
		}
	}
	return ips, count, nil
}
func (s *Store) admissionLiveReservedTx(tx *sql.Tx, account string, quota int64, now time.Time) (int64, string, error) {
	w, err := s.admissionLiveWindowTx(tx, budgetLive, account, now)
	if err != nil {
		return 0, "", err
	}
	if w == nil {
		return s.canonicalAdmissionReservedTx(tx, account, quota, now)
	}
	reserved := int64(0)
	pending := w.Expired > 0
	for _, v := range w.Budgets {
		if !v.Finite {
			pending = pending || quota > 0
			continue
		}
		cost, err := service.WeightedBytes(int64(v.GrantedRaw-v.SettledRaw), v.Rate.Micros)
		if err != nil || cost > math.MaxInt64-reserved {
			if err = s.markAdmissionExceptionalTx(tx, budgetLive); err != nil {
				return 0, "", err
			}
			return s.canonicalAdmissionReservedTx(tx, account, quota, now)
		}
		reserved += cost
	}
	if pending {
		return 0, "quota-budget-pending", nil
	}
	return reserved, "", nil
}
