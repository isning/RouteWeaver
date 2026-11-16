package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"routeweaver/internal/domain"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrMixedRetargetUnavailable = errors.New("mixed route reference proof unavailable")

const mixedRetargetRows = 64
const mixedRetargetRecordBytes = 64 << 10
const mixedRetargetBytes = 2 << 20

type mixedRetargetRecord struct {
	kind, id string
	size     int
	raw      json.RawMessage
}

// MixedRetargetFence is immutable evidence from the canonical records, not the
// recoverable queue. Only CaptureMixedRetargetFence can construct a valid one.
type MixedRetargetFence struct {
	store                 *Store
	routeID, deploymentID string
	records               []mixedRetargetRecord
	fingerprint           string
}

func (f *MixedRetargetFence) Fingerprint() string {
	if f == nil {
		return ""
	}
	return f.fingerprint
}

// CaptureMixedRetargetFence requires a pure, fail-closed classifier using the
// consumer's complete domain types. It must reject unknown fields and every
// relevant attribution reference, including terminal history and frozen plans.
// Each raw value passed to classify is a copy, never the retained proof bytes.
func (s *Store) CaptureMixedRetargetFence(ctx context.Context, routeID, deploymentID string, classify func(kind, id string, raw json.RawMessage) error) (*MixedRetargetFence, error) {
	if !domain.ValidID(routeID) || !domain.ValidID(deploymentID) || classify == nil {
		return nil, ErrMixedRetargetUnavailable
	}
	var records []mixedRetargetRecord
	err := s.readSnapshot(ctx, func(tx *sql.Tx) error { var e error; records, e = s.readMixedRetargetRecords(ctx, tx); return e })
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		if record.raw == nil {
			continue
		}
		if err = classify(record.kind, record.id, append(json.RawMessage(nil), record.raw...)); err != nil {
			return nil, err
		}
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	h := sha256.New()
	fmt.Fprintf(h, "%d:%s%d:%s", len(routeID), routeID, len(deploymentID), deploymentID)
	for _, r := range records {
		fmt.Fprintf(h, "%d:%s%d:%s%d:%d:", len(r.kind), r.kind, len(r.id), r.id, r.size, len(r.raw))
		h.Write(r.raw)
	}
	return &MixedRetargetFence{store: s, routeID: routeID, deploymentID: deploymentID, records: records, fingerprint: hex.EncodeToString(h.Sum(nil))}, nil
}

func (s *Store) readMixedRetargetRecords(ctx context.Context, tx *sql.Tx) ([]mixedRetargetRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	// All tenant rows count toward this index-range metadata limit, not only
	// suffix matches. A suffix filter before LIMIT would hide an unbounded scan.
	records := []mixedRetargetRecord{}
	scan := func(where string, args []any, limit int) error {
		query := ` FROM records WHERE ` + where + ` ORDER BY kind,id LIMIT ?`
		args = append(args, limit+1)
		rows, err := tx.QueryContext(ctx, `SELECT length(CAST(kind AS BLOB)),length(CAST(id AS BLOB)),length(data)`+query, args...)
		if err != nil {
			return err
		}
		n := 0
		for rows.Next() {
			var k, i, size int
			if err = rows.Scan(&k, &i, &size); err != nil {
				rows.Close()
				return err
			}
			n++
			if n > limit || k < 1 || k > 512 || i < 1 || i > 256 || size < 1 {
				rows.Close()
				return ErrMixedRetargetUnavailable
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		rows, err = tx.QueryContext(ctx, `SELECT kind,id,length(data)`+query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r mixedRetargetRecord
			if err = rows.Scan(&r.kind, &r.id, &r.size); err != nil {
				return err
			}
			records = append(records, r)
		}
		return rows.Err()
	}
	if err := scan(`kind >= 'tenant/' AND kind < 'tenant0'`, nil, 256); err != nil {
		return nil, err
	}
	globalStart := len(records)
	for _, kind := range []string{"entry-admission-bindings", "output-attribution-claims", "principal-service-migrations", "principal-provisioning-locks"} {
		left := mixedRetargetRows - (len(records) - globalStart)
		if err := scan(`kind=?`, []any{kind}, left); err != nil {
			return nil, err
		}
	}
	selected := []int{}
	bytesNeeded := 0
	for i, r := range records {
		include := true
		if strings.HasPrefix(r.kind, "tenant/") {
			owner, tail, ok := strings.Cut(strings.TrimPrefix(r.kind, "tenant/"), "/")
			if !ok || !domain.ValidID(owner) || tail == "" || strings.Contains(tail, "/") {
				return nil, ErrMixedRetargetUnavailable
			}
			include = tail == "output-attribution-intents" || tail == "platform-entries"
		}
		if !include {
			continue
		}
		validID := domain.ValidID(r.id)
		if r.kind == "entry-admission-bindings" || r.kind == "output-attribution-claims" {
			parts := strings.Split(r.id, ":")
			validID = len(parts) == 4
			for _, part := range parts {
				validID = validID && domain.ValidID(part)
			}
		}
		if !validID || r.size > mixedRetargetRecordBytes || r.size > mixedRetargetBytes-bytesNeeded || len(selected) >= mixedRetargetRows {
			return nil, ErrMixedRetargetUnavailable
		}
		bytesNeeded += r.size
		selected = append(selected, i)
	}
	plain := 0
	for _, i := range selected {
		r := &records[i]
		var encrypted []byte
		if err := tx.QueryRowContext(ctx, `SELECT data FROM records WHERE kind=? AND id=?`, r.kind, r.id).Scan(&encrypted); err != nil {
			return nil, err
		}
		if len(encrypted) != r.size {
			return nil, ErrMixedRetargetUnavailable
		}
		var raw json.RawMessage
		if err := s.open(r.kind, r.id, encrypted, &raw); err != nil {
			return nil, err
		}
		if len(raw) > mixedRetargetRecordBytes || len(raw) > mixedRetargetBytes-plain || !mixedRetargetJSON(raw) {
			return nil, ErrMixedRetargetUnavailable
		}
		plain += len(raw)
		r.raw = raw
	}
	return records, nil
}

// Reject duplicate or excessive JSON before any typed classification can hide
// a reference. Stored records must be objects, with exact EOF and bounded depth.
func mixedRetargetJSON(raw []byte) bool {
	if !utf8.Valid(raw) {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	tokens := 0
	var walk func(int) (bool, error)
	walk = func(depth int) (bool, error) {
		if depth > 32 {
			return false, nil
		}
		tok, e := d.Token()
		tokens++
		if e != nil || tokens > 16384 {
			return false, e
		}
		delimiter, compound := tok.(json.Delim)
		if !compound {
			return true, nil
		}
		if delimiter != '{' && delimiter != '[' {
			return false, nil
		}
		seen := map[string]bool{}
		for d.More() {
			if delimiter == '{' {
				key, e := d.Token()
				tokens++
				name, ok := key.(string)
				if e != nil || !ok || seen[name] || tokens > 16384 {
					return false, e
				}
				seen[name] = true
			}
			ok, e := walk(depth + 1)
			if e != nil || !ok {
				return false, e
			}
		}
		end, e := d.Token()
		tokens++
		return e == nil && tokens <= 16384 && ((delimiter == '{' && end == json.Delim('}')) || (delimiter == '[' && end == json.Delim(']'))), e
	}
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		return false
	}
	ok, e := walk(0)
	if !ok || e != nil {
		return false
	}
	_, e = d.Token()
	return e == io.EOF
}

// CompareMixedRetargetAndPutRecords rechecks canonical membership and exact raw
// values under the SAME writer reservation as the route/deployment mutation.
// Neither new owners nor orphaned/restored intents can evade this fence.
func (s *Store) CompareMixedRetargetAndPutRecords(ctx context.Context, f *MixedRetargetFence, compares []RecordCompare, sets []RecordSetCompare, writes []RecordWrite) error {
	if f == nil || f.store != s || f.fingerprint == "" {
		return ErrMixedRetargetUnavailable
	}
	hasRoute, hasDeployment := false, false
	for _, c := range compares {
		if c.Kind == "published-routes" && c.ID == f.routeID && c.Expected != nil {
			hasRoute = true
		}
		if c.Kind == "server-deployments" && c.ID == f.deploymentID && c.Expected != nil {
			hasDeployment = true
		}
	}
	if !hasRoute || !hasDeployment {
		return ErrMixedRetargetUnavailable
	}
	for _, w := range writes {
		compared := false
		for _, c := range compares {
			if c.Kind == w.Kind && c.ID == w.ID {
				compared = true
				break
			}
		}
		if !compared {
			return ErrMixedRetargetUnavailable
		}
		if !((w.Kind == "published-routes" && w.ID == f.routeID) || (w.Kind == "server-deployments" && w.ID == f.deploymentID) || w.Kind == "links" || w.Kind == "route-exit-receipts") {
			return ErrMixedRetargetUnavailable
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	current, err := s.readMixedRetargetRecords(ctx, tx)
	if err != nil {
		return err
	}
	if len(current) != len(f.records) {
		return ErrConflict
	}
	for i, r := range current {
		old := f.records[i]
		if r.kind != old.kind || r.id != old.id || r.size != old.size || !bytes.Equal(r.raw, old.raw) {
			return ErrConflict
		}
	}
	if err = s.compareRecordsTx(tx, compares, sets); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	for _, w := range writes {
		if err = s.putTx(tx, w.Kind, w.ID, w.Value); err != nil {
			return err
		}
	}
	return tx.Commit()
}
