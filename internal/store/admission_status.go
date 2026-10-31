package store

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"sort"
	"time"
)

// AdmissionStatus reports unexpired authoritative reservations, not a hardware
// device count or an independent assertion that an idle socket is still alive.
type AdmissionStatus struct {
	AsOf            time.Time              `json:"asOf"`
	MaxLeaseSeconds int                    `json:"maxLeaseSeconds"`
	OnlineIPs       []string               `json:"onlineIps"`
	ActiveStreams   int                    `json:"activeStreams"`
	Entries         []AdmissionEntryStatus `json:"entries"`
}
type AdmissionEntryStatus struct {
	InstanceID    string    `json:"instanceId"`
	EntryID       string    `json:"entryId"`
	ActiveStreams int       `json:"activeStreams"`
	LatestExpiry  time.Time `json:"latestExpiry"`
}

func (s *Store) AdmissionStatus(user string, now time.Time) (AdmissionStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := AdmissionStatus{AsOf: now, MaxLeaseSeconds: int(entrypolicy.MaxLease / time.Second), OnlineIPs: []string{}, Entries: []AdmissionEntryStatus{}}
	tx, e := s.db.Begin()
	if e != nil {
		return out, e
	}
	defer tx.Rollback()
	var account domain.User
	if e = s.getTx(tx, "users", user, &account); e != nil {
		return out, e
	}
	all, e := s.listTx(tx, "entry-admission-leases")
	if e != nil {
		return out, e
	}
	ips := map[string]bool{}
	entries := map[string]AdmissionEntryStatus{}
	for _, raw := range all {
		var lease admissionLease
		if e = json.Unmarshal(raw, &lease); e != nil {
			return out, e
		}
		if lease.Binding.UserID != user || !now.Before(lease.ExpiresAt) {
			continue
		}
		ips[lease.ClientIP] = true
		out.ActiveStreams++
		key := lease.Scope.InstanceID + ":" + lease.Binding.EntryID
		entry := entries[key]
		entry.InstanceID = lease.Scope.InstanceID
		entry.EntryID = lease.Binding.EntryID
		entry.ActiveStreams++
		if lease.ExpiresAt.After(entry.LatestExpiry) {
			entry.LatestExpiry = lease.ExpiresAt
		}
		entries[key] = entry
	}
	for ip := range ips {
		out.OnlineIPs = append(out.OnlineIPs, ip)
	}
	sort.Strings(out.OnlineIPs)
	keys := []string{}
	for key := range entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		out.Entries = append(out.Entries, entries[key])
	}
	return out, nil
}
