package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"routeweaver/internal/service"
	"time"
)

type activePolicyLimits struct {
	Policy  service.EffectivePolicy
	Streams int
	IPs     map[string]bool
}

func (s *Store) activePolicyLimitsTx(tx *sql.Tx, now time.Time) (map[string]activePolicyLimits, error) {
	records, e := s.listTx(tx, "entry-admission-leases")
	if e != nil {
		return nil, e
	}
	out := map[string]activePolicyLimits{}
	for _, raw := range records {
		var lease admissionLease
		if e = json.Unmarshal(raw, &lease); e != nil {
			return nil, e
		}
		if !now.Before(lease.ExpiresAt) {
			continue
		}
		id := lease.Binding.UserID
		entry, ok := out[id]
		if !ok {
			policy, e := s.effectivePolicyTx(tx, id, now)
			if e != nil {
				return nil, e
			}
			entry = activePolicyLimits{Policy: policy, IPs: map[string]bool{}}
		}
		entry.Streams++
		entry.IPs[lease.ClientIP] = true
		out[id] = entry
	}
	return out, nil
}

// Reductions never strand existing admissions above a new configured cap.
// Administrators close sufficient streams/IPs first, then retry their preview.
func (s *Store) guardActivePolicyLimits(tx *sql.Tx, before map[string]activePolicyLimits, now time.Time) error {
	for id, active := range before {
		after, e := s.effectivePolicyTx(tx, id, now)
		if e != nil {
			return e
		}
		if after.ConnectionLimit > 0 && (active.Policy.ConnectionLimit == 0 || after.ConnectionLimit < active.Policy.ConnectionLimit) && active.Streams > after.ConnectionLimit {
			return fmt.Errorf("connection limit reduction for user %s is below %d active streams; close enough streams before applying", id, active.Streams)
		}
		if after.OnlineIPLimit > 0 && (active.Policy.OnlineIPLimit == 0 || after.OnlineIPLimit < active.Policy.OnlineIPLimit) && len(active.IPs) > after.OnlineIPLimit {
			return fmt.Errorf("online IP limit reduction for user %s is below %d active IPs; close enough presences before applying", id, len(active.IPs))
		}
	}
	return nil
}
