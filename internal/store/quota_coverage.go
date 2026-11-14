package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"math"
	"reflect"
	"routeweaver/internal/domain"
	"strings"
	"time"
)

const quotaCoverageKind = "quota-coverage-checkpoints"
const quotaCoverageLimit = 256
const quotaCheckpointVersion = 2

// A checkpoint is evidence only from StartedAt forward. It never upgrades old
// usage or turns an empty ledger into zero usage. Mutations invalidate it in the
// same transaction as the authoritative source, including transient ABA changes.
type quotaCoverageCheckpoint struct {
	Epoch           string                   `json:"epoch"`
	Version         int                      `json:"version"`
	AccountID       string                   `json:"accountId"`
	Generation      uint64                   `json:"generation,string"`
	StartedAt       time.Time                `json:"startedAt"`
	Invalid         bool                     `json:"invalid"`
	Dependencies    []quotaSourceDependency  `json:"dependencies"`
	RouteIDs        []string                 `json:"routeIds"`
	Open            uint64                   `json:"open,string"`
	LastEventAt     time.Time                `json:"lastEventAt"`
	LastWindowStart time.Time                `json:"lastWindowStart"`
	Windows         []quotaObservationWindow `json:"windows"`
}

func quotaSourceMutationKind(kind string) bool {
	switch kind {
	case "entry-admission-bindings", "meter-bindings", "agent-observations", "agent-desired", "agent-enrollments", "instance-enrollments", "published-manifests", "published-routes", "server-deployments", "managed-endpoints", "core-instances", "users", "rates", "issued-principal-credentials", "output-attribution-claims", "output-attribution-intents", "memberships", "group-memberships", "ledger":
		return true
	}
	return strings.HasPrefix(kind, "tenant/") && (strings.HasSuffix(kind, "/platform-entries") || strings.HasSuffix(kind, "/entry-versions") || strings.HasSuffix(kind, "/output-attribution-intents"))
}

// Only the forecast projection is parsed here; authorization and source
// semantics remain in their typed APIs. No canonical source is modified.
func (s *Store) prepareQuotaCoverageMutationTx(tx *sql.Tx, kind, id string, next []byte) ([]quotaCoverageCheckpoint, error) {
	if kind == "admission-budgets" {
		return s.prepareQuotaBudgetMutationTx(tx, id, next)
	}
	if !quotaSourceMutationKind(kind) {
		return nil, nil
	}
	var prior []byte
	err := tx.QueryRow(`SELECT data FROM records WHERE kind=? AND id=?`, kind, id).Scan(&prior)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if kind == "users" && prior != nil && next != nil {
		var a, b domain.User
		if s.open(kind, id, prior, &a) == nil && s.open(kind, id, next, &b) == nil && a.ID == id && b.ID == id {
			return nil, nil
		}
	}
	if kind == "agent-observations" && prior != nil && next != nil {
		var a, b appliedManifestObservation
		if s.open(kind, id, prior, &a) == nil && s.open(kind, id, next, &b) == nil && reflect.DeepEqual(a, b) {
			return nil, nil
		}
	}
	if kind == "published-manifests" && prior != nil && next != nil {
		var a, b domain.PublishedManifest
		if s.open(kind, id, prior, &a) == nil && s.open(kind, id, next, &b) == nil && !b.PolicyExpiresAt.Before(a.PolicyExpiresAt) {
			a.PolicyExpiresAt = time.Time{}
			b.PolicyExpiresAt = time.Time{}
			if reflect.DeepEqual(a, b) {
				return nil, nil
			}
		}
	}
	owners := map[string]bool{}
	routes := map[string]bool{}
	uncertain := false
	for _, raw := range [][]byte{prior, next} {
		if raw == nil {
			continue
		}
		var fields struct {
			UserID    string `json:"userId"`
			AccountID string `json:"accountId"`
			RouteID   string `json:"routeId"`
			BudgetID  string `json:"budgetId"`
		}
		if err = s.open(kind, id, raw, &fields); err != nil {
			uncertain = true
			continue
		}
		// A newly appended managed receipt is normal usage, not a source change.
		// Replacing/deleting an existing ledger record is never this exception.
		if kind == "ledger" && prior == nil && fields.BudgetID != "" {
			return nil, nil
		}
		if fields.UserID != "" {
			owners[fields.UserID] = true
		}
		if fields.AccountID != "" {
			owners[fields.AccountID] = true
		}
		if fields.RouteID != "" {
			routes[fields.RouteID] = true
		}
		if (kind == "entry-admission-bindings" || kind == "meter-bindings" || kind == "ledger") && fields.UserID == "" {
			uncertain = true
		}
	}
	if strings.HasPrefix(kind, "tenant/") {
		parts := strings.Split(kind, "/")
		if len(parts) == 3 {
			owners[parts[1]] = true
		}
	}
	if kind == "users" || kind == "entitlements" {
		owners[id] = true
	}
	rows, err := tx.Query(`SELECT id, CASE WHEN length(data)<=65536 THEN data ELSE NULL END FROM records WHERE kind=? LIMIT ?`, quotaCoverageKind, quotaCoverageLimit+1)
	if err != nil {
		return nil, err
	}
	var candidates []quotaCoverageCheckpoint
	for rows.Next() {
		var account string
		var raw []byte
		if err = rows.Scan(&account, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		var c quotaCoverageCheckpoint
		if len(raw) == 0 || s.open(quotaCoverageKind, account, raw, &c) != nil || c.Version != quotaCheckpointVersion || c.AccountID != account {
			// A broken optional checkpoint cannot block editing its source. Replace
			// only this projection with explicit unknown rather than salvaging history.
			c = quotaCoverageCheckpoint{Version: quotaCheckpointVersion, AccountID: account, Invalid: true}
		}
		candidates = append(candidates, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(candidates) > quotaCoverageLimit {
		return []quotaCoverageCheckpoint{{Invalid: true}}, nil
	}
	changed := []quotaCoverageCheckpoint{}
	for _, c := range candidates {
		if c.Invalid {
			continue
		}
		hit := uncertain || owners[c.AccountID]
		for _, d := range c.Dependencies {
			if d.Kind == kind && d.ID == id {
				hit = true
			}
		}
		if kind == "rates" {
			for _, route := range c.RouteIDs {
				if routes[route] {
					hit = true
				}
			}
		}
		if !hit {
			continue
		}
		c.Invalid = true
		c.StartedAt = time.Time{}
		if c.Generation < math.MaxUint64 {
			c.Generation++
		}
		changed = append(changed, c)
	}
	return changed, nil
}
func (s *Store) finishQuotaCoverageMutationTx(tx *sql.Tx, changed []quotaCoverageCheckpoint) error {
	for _, c := range changed {
		if c.AccountID == "" {
			if err := s.putTx(tx, "quota-coverage-safety", "unknown", true); err != nil {
				return err
			}
			continue
		}
		if err := s.putTx(tx, quotaCoverageKind, c.AccountID, c); err != nil {
			return err
		}
	}
	return nil
}

// Importing canonical history cannot restore an already-observed coverage
// window: the live source may have continued while the backup was offline.
func (s *Store) invalidateRestoredQuotaCoverageTx(tx *sql.Tx) error {
	return s.writeQuotaCoverageEpochTx(tx, true)
}
func (s *Store) initializeQuotaCoverage() error {
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.writeQuotaCoverageEpochTx(tx, false); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) writeQuotaCoverageEpochTx(tx *sql.Tx, rotate bool) error {
	if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS quota_coverage_state(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL)`); err != nil {
		return err
	}
	if !rotate {
		var count int
		if err := tx.QueryRow(`SELECT count(*) FROM quota_coverage_state WHERE id=1`).Scan(&count); err != nil {
			return err
		}
		if count == 1 {
			return nil
		}
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT INTO quota_coverage_state(id,epoch) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch`, hex.EncodeToString(token))
	return err
}
func quotaCoverageEpochTx(tx *sql.Tx) (string, error) {
	var epoch string
	err := tx.QueryRow(`SELECT epoch FROM quota_coverage_state WHERE id=1`).Scan(&epoch)
	return epoch, err
}

// Corrupt optional evidence is unknown, not a reason to reject a valid byte
// settlement. Database I/O errors still propagate atomically.
func (s *Store) readQuotaCheckpointTx(tx *sql.Tx, account string) (quotaCoverageCheckpoint, bool, error) {
	var raw []byte
	err := tx.QueryRow(`SELECT CASE WHEN length(data)<=65536 THEN data ELSE NULL END FROM records WHERE kind=? AND id=?`, quotaCoverageKind, account).Scan(&raw)
	if err == sql.ErrNoRows {
		return quotaCoverageCheckpoint{}, false, nil
	}
	if err != nil {
		return quotaCoverageCheckpoint{}, false, err
	}
	var c quotaCoverageCheckpoint
	if len(raw) == 0 || s.open(quotaCoverageKind, account, raw, &c) != nil || c.Version != quotaCheckpointVersion || c.AccountID != account || c.LastEventAt.IsZero() || c.LastEventAt.Before(c.StartedAt) || len(c.Dependencies) > 512 || len(c.RouteIDs) > 64 || len(c.Windows) > 9 {
		return quotaCoverageCheckpoint{Version: quotaCheckpointVersion, AccountID: account, Invalid: true}, true, nil
	}
	epoch, err := quotaCoverageEpochTx(tx)
	if err != nil {
		return quotaCoverageCheckpoint{}, false, err
	}
	if len(epoch) != 64 || c.Epoch != epoch {
		c.Invalid = true
		c.StartedAt = time.Time{}
	}
	return c, true, nil
}

// Legacy/manual usage is not part of the managed budget proof. A quota limit
// edit itself is not usage and must not restart an otherwise complete window.
func (s *Store) invalidateQuotaAccountTx(tx *sql.Tx, account string) error {
	c, found, err := s.readQuotaCheckpointTx(tx, account)
	if err != nil {
		return err
	}
	if !found || c.Invalid {
		return nil
	}
	c.invalidateQuota()
	return s.putTx(tx, quotaCoverageKind, account, c)
}
