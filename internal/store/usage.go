package store

import (
	"database/sql"
	"fmt"
	"routeweaver/internal/domain"
)

// RecordUsage atomically applies an idempotent usage batch. A repeated batch with
// different bytes is rejected. This is control-plane accounting, not traffic enforcement.
func (s *Store) RecordUsage(userID, batchID string, bytes int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !domain.ValidID(batchID) || bytes < 0 {
		return fmt.Errorf("valid batch id and non-negative bytes required")
	}
	st, e := s.state()
	if e != nil {
		return e
	}
	var user *domain.User
	for i := range st.Users {
		if st.Users[i].ID == userID {
			user = &st.Users[i]
		}
	}
	if user == nil {
		return ErrNotFound
	}
	key := userID + ":" + batchID
	var old []byte
	e = s.db.QueryRow(`SELECT data FROM records WHERE kind='usage' AND id=?`, key).Scan(&old)
	if e == nil {
		var recorded int64
		if e = s.open("usage", key, old, &recorded); e != nil {
			return e
		}
		if recorded != bytes {
			return fmt.Errorf("batch id already has different amount")
		}
		return nil
	}
	if e != sql.ErrNoRows {
		return e
	}
	if !user.Enabled {
		return fmt.Errorf("user disabled")
	}
	if bytes > int64(^uint64(0)>>1)-user.UsedBytes {
		return fmt.Errorf("usage overflow")
	}
	if user.QuotaBytes > 0 && bytes > user.QuotaBytes-user.UsedBytes {
		return fmt.Errorf("quota exceeded")
	}
	user.UsedBytes += bytes
	ub, e := s.seal("users", userID, user)
	if e != nil {
		return e
	}
	bb, e := s.seal("usage", key, bytes)
	if e != nil {
		return e
	}
	tx, e := s.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`INSERT INTO records(kind,id,data) VALUES('usage',?,?)`, key, bb); e != nil {
		return e
	}
	if _, e = tx.Exec(`UPDATE records SET data=? WHERE kind='users' AND id=?`, ub, userID); e != nil {
		return e
	}
	return tx.Commit()
}
