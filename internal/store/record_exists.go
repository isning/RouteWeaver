package store

// RecordExists reads only presence metadata, including for unreadable records.
// It is not a write precondition: callers must retain an atomic comparison when
// committing a create that requires absence. Database read errors stay errors.
func (s *Store) RecordExists(kind, id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var exists bool
	err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM records WHERE kind=? AND id=?)`, kind, id).Scan(&exists)
	return exists, err
}
