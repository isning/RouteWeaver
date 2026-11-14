package store

import (
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strings"
	"time"
)

const SubscriptionFetchLimit = 100
const SubscriptionFetchWindowDays = 30

// SubscriptionFetch records a completed HTTP response write, not successful
// client import or proxy traffic. It excludes token and UA; IP collection requires an explicit owner opt-in.
type SubscriptionFetch struct {
	SourceIP  string    `json:"sourceIp,omitempty"`
	NewSource bool      `json:"newSource,omitempty"`
	OutputID  string    `json:"outputId"`
	At        time.Time `json:"at"`
	Delivery  string    `json:"delivery"`
}
type SubscriptionFetchHistory struct {
	TrackSourceIPs      bool                `json:"trackSourceIps"`
	Items               []SubscriptionFetch `json:"items"`
	CollectionStartedAt *time.Time          `json:"collectionStartedAt,omitempty"`
	Limit               int                 `json:"limit"`
	WindowDays          int                 `json:"windowDays"`
}

func pruneSubscriptionFetches(h *SubscriptionFetchHistory, now time.Time) {
	cutoff := now.Add(-SubscriptionFetchWindowDays * 24 * time.Hour)
	kept := make([]SubscriptionFetch, 0, len(h.Items))
	for _, item := range h.Items {
		if !item.At.Before(cutoff) {
			kept = append(kept, item)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool { return kept[i].At.After(kept[j].At) })
	if len(kept) > SubscriptionFetchLimit {
		kept = kept[:SubscriptionFetchLimit]
	}
	h.Items = kept
	h.Limit = SubscriptionFetchLimit
	h.WindowDays = SubscriptionFetchWindowDays
}
func validFetchOwner(owner string) bool {
	return owner != "" && len(owner) <= 256 && !strings.Contains(owner, "/")
}

// One encrypted bounded record per owner; an immediate transaction prevents
// lost updates across Store handles. Old rows are pruned on read/write; this is
// a query window, not a promise that inactive owners' backup bytes expire.
func (s *Store) RecordSubscriptionFetch(owner string, item SubscriptionFetch) error {
	if !validFetchOwner(owner) || item.OutputID == "" || len(item.OutputID) > 256 || item.At.IsZero() || (item.Delivery != "feed" && item.Delivery != "bundle") {
		return fmt.Errorf("invalid subscription fetch")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	kind := TenantKind(owner, "subscription-fetches")
	var h SubscriptionFetchHistory
	if err = s.getTx(tx, kind, "recent", &h); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	item.At = item.At.UTC()
	if h.CollectionStartedAt == nil {
		at := item.At
		h.CollectionStartedAt = &at
	}
	// Never accept a caller-provided alert decision. The preference and baseline
	// are read under the same transaction as this append (including disable races).
	item.NewSource = false
	if !h.TrackSourceIPs {
		item.SourceIP = ""
	}
	if ip, e := netip.ParseAddr(item.SourceIP); e == nil && ip.Zone() == "" && !ip.IsUnspecified() && !ip.IsMulticast() {
		item.SourceIP = ip.Unmap().String()
	} else {
		item.SourceIP = ""
	}
	pruneSubscriptionFetches(&h, item.At)
	if item.SourceIP != "" {
		baseline, seen := false, false
		for _, old := range h.Items {
			if old.OutputID == item.OutputID && old.SourceIP != "" {
				baseline = true
				if old.SourceIP == item.SourceIP {
					seen = true
				}
			}
		}
		item.NewSource = baseline && !seen
	}
	h.Items = append(h.Items, item)
	pruneSubscriptionFetches(&h, item.At)
	if err = s.putTx(tx, kind, "recent", h); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) SubscriptionFetches(owner string, now time.Time) (SubscriptionFetchHistory, error) {
	h := SubscriptionFetchHistory{Items: []SubscriptionFetch{}, Limit: SubscriptionFetchLimit, WindowDays: SubscriptionFetchWindowDays}
	if !validFetchOwner(owner) || now.IsZero() {
		return h, fmt.Errorf("invalid history query")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.beginWriteTx()
	if err != nil {
		return h, err
	}
	defer tx.Rollback()
	kind := TenantKind(owner, "subscription-fetches")
	if err = s.getTx(tx, kind, "recent", &h); errors.Is(err, ErrNotFound) {
		return h, nil
	} else if err != nil {
		return h, err
	}
	before := len(h.Items)
	pruneSubscriptionFetches(&h, now.UTC())
	if len(h.Items) != before {
		if err = s.putTx(tx, kind, "recent", h); err != nil {
			return h, err
		}
	}
	return h, tx.Commit()
}

// SetSubscriptionFetchSourceTracking changes only this owner's opt-in. Turning
// it off removes addresses and alert markers from the live encrypted row, while
// preserving the original response-write history. Backups are not rewritten.
func (s *Store) SetSubscriptionFetchSourceTracking(owner string, enabled bool, now time.Time) error {
	if !validFetchOwner(owner) || now.IsZero() {
		return fmt.Errorf("invalid history preference")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.beginWriteTx()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	kind := TenantKind(owner, "subscription-fetches")
	var h SubscriptionFetchHistory
	if err = s.getTx(tx, kind, "recent", &h); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	h.TrackSourceIPs = enabled
	if !enabled {
		for i := range h.Items {
			h.Items[i].SourceIP = ""
			h.Items[i].NewSource = false
		}
	}
	pruneSubscriptionFetches(&h, now.UTC())
	if err = s.putTx(tx, kind, "recent", h); err != nil {
		return err
	}
	return tx.Commit()
}
