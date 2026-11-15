package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

// TenantSummaryPage bounds background summaries before decrypting large records.
// Partial means this is not a complete inventory, including an oversized row.
func (s *Store) TenantSummaryPage(ctx context.Context, owner, kind string, limit, maxBytes int) ([]json.RawMessage, bool, error) {
	if owner == "" || limit < 1 || limit > 100 || maxBytes < 1 || maxBytes > 4<<20 {
		return nil, false, fmt.Errorf("invalid summary budget")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kind = TenantKind(owner, kind)
	rows, err := s.db.QueryContext(ctx, `SELECT id, CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind=? ORDER BY id LIMIT ?`, maxBytes, kind, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	partial := false
	used := 0
	seen := 0
	for rows.Next() {
		seen++
		if seen > limit {
			partial = true
			break
		}
		var id string
		var b []byte
		if err = rows.Scan(&id, &b); err != nil {
			return nil, false, err
		}
		if len(b) == 0 || len(b) > maxBytes-used {
			partial = true
			continue
		}
		used += len(b)
		var raw json.RawMessage
		if err = s.open(kind, id, b, &raw); err != nil {
			return nil, false, err
		}
		out = append(out, raw)
	}
	return out, partial, rows.Err()
}

// TenantSummaryGet rejects oversized ciphertext before allocating/decrypting it.
func (s *Store) TenantSummaryGet(owner, kind, id string, maxBytes int, out any) error {
	if owner == "" || maxBytes < 1 || maxBytes > 4<<20 {
		return fmt.Errorf("invalid summary budget")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	kind = TenantKind(owner, kind)
	var b []byte
	err := s.db.QueryRow(`SELECT CASE WHEN length(data)<=? THEN data ELSE NULL END FROM records WHERE kind=? AND id=?`, maxBytes, kind, id).Scan(&b)
	if err == sql.ErrNoRows {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return fmt.Errorf("summary input budget exceeded")
	}
	return s.open(kind, id, b, out)
}
