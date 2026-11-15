package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"time"
)

var ErrPlatformComparisonUnavailable = errors.New("platform comparison unavailable")

const platformComparisonRows = 64
const platformComparisonBytes = 2 << 20
const platformComparisonRecordBytes = 64 << 10

// PlatformComparisonSnapshot is private, immutable as-of evidence, not a delivery
// authorization. No projection is repaired and no source is fetched by this read.
type PlatformComparisonSnapshot struct {
	owner       string
	records     map[string]map[string]json.RawMessage
	ids         map[string][]string
	fingerprint string
	eligible    bool
	validUntil  time.Time
	policy      service.EffectivePolicy
}

func (p *PlatformComparisonSnapshot) ValidUntil() time.Time { return p.validUntil }
func (p *PlatformComparisonSnapshot) Fingerprint() string   { return p.fingerprint }
func (p *PlatformComparisonSnapshot) Get(kind, id string, out any) error {
	records, ok := p.records[kind]
	if !ok {
		return ErrPlatformComparisonUnavailable
	}
	raw, ok := records[id]
	if !ok {
		return ErrNotFound
	}
	return json.Unmarshal(raw, out)
}
func (p *PlatformComparisonSnapshot) List(kind string) ([]json.RawMessage, error) {
	records, ok := p.records[kind]
	if !ok {
		return nil, ErrPlatformComparisonUnavailable
	}
	out := make([]json.RawMessage, 0, len(records))
	for _, id := range p.ids[kind] {
		out = append(out, append(json.RawMessage(nil), records[id]...))
	}
	return out, nil
}
func (p *PlatformComparisonSnapshot) TenantGet(owner, kind, id string, out any) error {
	if owner != p.owner {
		return ErrPlatformComparisonUnavailable
	}
	return p.Get(TenantKind(owner, kind), id, out)
}
func (p *PlatformComparisonSnapshot) Eligible(route string) error {
	if !p.eligible || !p.policy.AllowsRoute(route) {
		return ErrPlatformComparisonUnavailable
	}
	// Match overview and refuse corrupted inventory identity.
	for _, kind := range []string{"routes", "published-routes"} {
		if raw, ok := p.records[kind][route]; ok {
			var v struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(raw, &v) != nil || v.ID != route {
				return ErrPlatformComparisonUnavailable
			}
			return nil
		}
	}
	return ErrPlatformComparisonUnavailable
}

// PlatformComparisonSnapshot captures complete small collections in one read
// transaction. Larger installations are deliberately unchecked, not truncated.
// Limits apply before decryption and again to retained plaintext, including all
// unrelated rows in collections whose absence/membership affects the proof.
func (s *Store) PlatformComparisonSnapshot(ctx context.Context, owner string, now time.Time, budget *int) (*PlatformComparisonSnapshot, error) {
	if !domain.ValidID(owner) || now.IsZero() || budget == nil || *budget <= 0 || *budget > platformComparisonBytes {
		return nil, ErrPlatformComparisonUnavailable
	}
	p := &PlatformComparisonSnapshot{owner: owner, records: map[string]map[string]json.RawMessage{}, ids: map[string][]string{}}
	kinds := []string{"users", "accounts", "entitlements", "services", "user-groups", "routes", "published-routes", "agent-observations", "published-manifests", "instance-enrollments", "resets", "ledger", "accounting-holds", "admission-budgets"}
	for _, kind := range []string{"platform-entries", "profiles", "outputs", "sources", "collections", "resources", "resource-versions"} {
		kinds = append(kinds, TenantKind(owner, kind))
	}
	err := s.readSnapshot(ctx, func(tx *sql.Tx) error {
		count, encryptedBytes, plainBytes := 0, 0, 0
		p.validUntil = now.Add(time.Minute)
		deadline := func(t time.Time) {
			if !t.IsZero() && t.Before(p.validUntil) {
				p.validUntil = t
			}
		}
		hash := sha256.New()
		for _, kind := range kinds {
			p.records[kind] = map[string]json.RawMessage{}
			// Preflight lengths without allocating ciphertext; the read transaction
			// ensures the subsequent reads cannot grow between check and consume.
			metaQuery := `SELECT length(CAST(id AS BLOB)),length(data) FROM records WHERE kind=?`
			metaArgs := []any{kind}
			if kind == "users" || kind == "accounts" || kind == "entitlements" {
				metaQuery += ` AND id=?`
				metaArgs = append(metaArgs, owner)
			}
			metaQuery += ` ORDER BY id LIMIT ?`
			metaArgs = append(metaArgs, platformComparisonRows-count+1)
			meta, e := tx.QueryContext(ctx, metaQuery, metaArgs...)
			if e != nil {
				return e
			}
			needed, entries := 0, 0
			for meta.Next() {
				var idBytes, n int
				if e = meta.Scan(&idBytes, &n); e != nil {
					meta.Close()
					return e
				}
				entries++
				needed += n
				if idBytes <= 0 || idBytes > 256 || count+entries > platformComparisonRows || n <= 0 || n > platformComparisonRecordBytes || needed > *budget {
					meta.Close()
					return ErrPlatformComparisonUnavailable
				}
			}
			e = meta.Err()
			meta.Close()
			if e != nil {
				return e
			}
			query := `SELECT id, CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind=?`
			args := []any{platformComparisonRecordBytes, kind}
			if kind == "users" || kind == "accounts" || kind == "entitlements" {
				query += ` AND id=?`
				args = append(args, owner)
			}
			query += ` ORDER BY id LIMIT ?`
			args = append(args, platformComparisonRows-count+1)
			rows, e := tx.QueryContext(ctx, query, args...)
			if e != nil {
				return e
			}
			for rows.Next() {
				if e = ctx.Err(); e != nil {
					rows.Close()
					return e
				}
				var id string
				var encrypted []byte
				if e = rows.Scan(&id, &encrypted); e != nil {
					rows.Close()
					return e
				}
				count++
				encryptedBytes += len(encrypted)
				*budget -= len(encrypted)
				if *budget < 0 {
					*budget = 0
					rows.Close()
					return ErrPlatformComparisonUnavailable
				}
				if count > platformComparisonRows || len(encrypted) == 0 || encryptedBytes > platformComparisonBytes {
					rows.Close()
					return ErrPlatformComparisonUnavailable
				}
				var raw json.RawMessage
				if e = s.open(kind, id, encrypted, &raw); e != nil {
					rows.Close()
					return e
				}
				plainBytes += len(raw)
				if len(raw) > platformComparisonRecordBytes || plainBytes > platformComparisonBytes {
					rows.Close()
					return ErrPlatformComparisonUnavailable
				}
				p.records[kind][id] = raw
				p.ids[kind] = append(p.ids[kind], id)
				// Length-prefix prevents kind/id/content boundary ambiguity.
				fmt.Fprintf(hash, "%d:%s%d:%s%d:", len(kind), kind, len(id), id, len(raw))
				hash.Write(raw)
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return e
			}
		}
		var e error
		// Evaluate the same pure policy function from captured input; no second
		// decryption pass or unbudgeted store callback is permitted.
		var policyUser domain.User
		if e = p.Get("users", owner, &policyUser); e != nil {
			return e
		}
		input := service.PolicyInput{UserID: owner, Enabled: policyUser.Enabled, QuotaBytes: policyUser.QuotaBytes, Entitlement: service.Entitlement{UserID: owner, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}}
		var policyAccount Account
		if e = p.Get("accounts", owner, &policyAccount); e == nil {
			input.Enabled = input.Enabled && !policyAccount.Disabled
		} else if e != ErrNotFound {
			return e
		}
		if e = p.Get("entitlements", owner, &input.Entitlement); e != nil && e != ErrNotFound {
			return e
		}
		for _, recordID := range p.ids["services"] {
			raw := p.records["services"][recordID]
			var v service.Plan
			if e = json.Unmarshal(raw, &v); e != nil {
				return e
			}
			input.Plans = append(input.Plans, v)
		}
		for _, recordID := range p.ids["user-groups"] {
			raw := p.records["user-groups"][recordID]
			var v service.Group
			if e = json.Unmarshal(raw, &v); e != nil {
				return e
			}
			input.Groups = append(input.Groups, v)
		}
		for _, recordID := range p.ids["routes"] {
			raw := p.records["routes"][recordID]
			var v domain.Route
			if e = json.Unmarshal(raw, &v); e != nil {
				return e
			}
			for _, id := range v.UserIDs {
				if id == owner {
					input.DirectRouteIDs = append(input.DirectRouteIDs, v.ID)
				}
			}
		}
		p.policy = service.ResolvePolicy(input, now)
		if p.policy.Entitlement.ExpiresAt != nil {
			deadline(*p.policy.Entitlement.ExpiresAt)
		}
		var user domain.User
		var account Account
		if e = p.Get("users", owner, &user); e != nil {
			return e
		}
		if e = p.Get("accounts", owner, &account); e != nil {
			return e
		}
		p.eligible = user.ID == owner && user.Enabled && account.ID == owner && !account.Disabled && p.policy.Status == "active"
		window, e := p.policy.Entitlement.Cycle.Window(now)
		if e != nil {
			return e
		}
		if window.NextReset != nil {
			deadline(*window.NextReset)
		}
		if p.policy.QuotaBytes > 0 && window.Start.After(now) {
			return ErrPlatformComparisonUnavailable
		}
		resets, _ := p.List("resets")
		for _, raw := range resets {
			var r Reset
			if e = json.Unmarshal(raw, &r); e != nil {
				return e
			}
			if r.UserID == owner && r.At.After(now) {
				return ErrPlatformComparisonUnavailable
			}
			if r.UserID == owner && r.At.After(window.Start) && !r.At.After(now) {
				window.Start = r.At
			}
		}
		ledger, _ := p.List("ledger")
		for _, raw := range ledger {
			var r MeterRecord
			if e = json.Unmarshal(raw, &r); e != nil {
				return e
			}
			if r.UserID == owner && r.ObservedAt.After(now) {
				return ErrPlatformComparisonUnavailable
			}
		}
		usage, e := aggregateUsageRecords(ledger, owner, window.Start, now.Add(time.Nanosecond))
		if e != nil {
			return e
		}
		if p.policy.QuotaBytes > 0 && usage.WeightedBytes >= p.policy.QuotaBytes {
			p.eligible = false
		}
		holds, _ := p.List("accounting-holds")
		for _, raw := range holds {
			var h AccountingHold
			if e = json.Unmarshal(raw, &h); e != nil {
				return e
			}
			if h.UserID == owner {
				p.eligible = false
			}
		}
		budgets, _ := p.List("admission-budgets")
		for _, raw := range budgets {
			var b admissionBudget
			if e = json.Unmarshal(raw, &b); e != nil {
				return e
			}
			if b.AccountID == owner && !b.Closed && (!b.Finite || b.GrantedRaw > b.SettledRaw) && now.Before(b.ExpiresAt) {
				deadline(b.ExpiresAt)
			}
			if b.AccountID == owner && !b.Closed && !now.Before(b.ExpiresAt) && (!b.Finite || b.GrantedRaw > b.SettledRaw) {
				p.eligible = false
			}
		}
		p.fingerprint = hex.EncodeToString(hash.Sum(nil))
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPlatformComparisonUnavailable, err)
	}
	return p, nil
}
