package store

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/notifications"
	"routeweaver/internal/service"
	"time"
)

// NotificationInputs reads one consistent policy/usage snapshot. A single
// streaming pass over canonical meters replaces one full-ledger scan per user;
// exact fractional rounding and the overview's half-open time window are kept.
func (s *Store) NotificationInputs(now time.Time) ([]notifications.Recipient, []notifications.UserSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	users := []domain.User{}
	accounts := map[string]Account{}
	entitlements := map[string]service.Entitlement{}
	plans := []service.Plan{}
	groups := []service.Group{}
	routes := []domain.Route{}
	for _, kind := range []string{"users", "accounts", "entitlements", "services", "user-groups", "routes"} {
		raw, e := s.listTx(tx, kind)
		if e != nil {
			return nil, nil, e
		}
		for _, b := range raw {
			switch kind {
			case "users":
				var v domain.User
				err = json.Unmarshal(b, &v)
				users = append(users, v)
			case "accounts":
				var v Account
				err = json.Unmarshal(b, &v)
				accounts[v.ID] = v
			case "entitlements":
				var v service.Entitlement
				err = json.Unmarshal(b, &v)
				entitlements[v.UserID] = v
			case "services":
				var v service.Plan
				err = json.Unmarshal(b, &v)
				plans = append(plans, v)
			case "user-groups":
				var v service.Group
				err = json.Unmarshal(b, &v)
				groups = append(groups, v)
			case "routes":
				var v domain.Route
				err = json.Unmarshal(b, &v)
				routes = append(routes, v)
			}
			if err != nil {
				return nil, nil, err
			}
		}
	}
	direct := map[string][]string{}
	for _, route := range routes {
		for _, id := range route.UserIDs {
			direct[id] = append(direct[id], route.ID)
		}
	}
	recipients := []notifications.Recipient{{ID: "operator", Role: "admin", Enabled: true}}
	out := []notifications.UserSnapshot{}
	windows := map[string]*usageWindow{}
	for _, user := range users {
		role, enabled := "user", user.Enabled
		if a, ok := accounts[user.ID]; ok {
			role = a.Role
			enabled = enabled && !a.Disabled
		}
		recipients = append(recipients, notifications.Recipient{ID: user.ID, Role: role, Enabled: enabled})
		if !enabled {
			continue
		}
		entitlement, ok := entitlements[user.ID]
		if !ok {
			entitlement = service.Entitlement{UserID: user.ID, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}
		}
		policy := service.ResolvePolicy(service.PolicyInput{UserID: user.ID, Enabled: enabled, QuotaBytes: user.QuotaBytes, Entitlement: entitlement, Plans: plans, Groups: groups, DirectRouteIDs: direct[user.ID]}, now)
		cycle, e := policy.Entitlement.Cycle.Window(now)
		if e != nil {
			return nil, nil, e
		}
		windows[user.ID] = &usageWindow{Start: cycle.Start, End: now.Add(time.Nanosecond), Raw: "0", Provider: "0", Numerator: "0"}
		out = append(out, notifications.UserSnapshot{UserID: user.ID, Enabled: enabled, QuotaBytes: policy.QuotaBytes, ExpiresAt: policy.Entitlement.ExpiresAt})
	}
	if len(out) == 0 {
		return recipients, out, nil
	}
	// Resets and meters are streamed; no complete historical ledger allocation.
	for _, kind := range []string{"resets", "ledger"} {
		rows, e := tx.Query(`SELECT id,data FROM records WHERE kind=? ORDER BY id`, kind)
		if e != nil {
			return nil, nil, e
		}
		for rows.Next() {
			var id string
			var b []byte
			if err = rows.Scan(&id, &b); err != nil {
				break
			}
			if kind == "resets" {
				var reset Reset
				if err = s.open(kind, id, b, &reset); err != nil {
					break
				}
				if w := windows[reset.UserID]; w != nil && reset.At.After(w.Start) && !reset.At.After(now) {
					w.Start = reset.At
				}
			} else {
				var meter MeterRecord
				if err = s.open(kind, id, b, &meter); err != nil {
					break
				}
				if w := windows[meter.UserID]; w != nil {
					if err = w.apply(&meter, 1); err != nil {
						break
					}
				}
			}
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return nil, nil, err
		}
	}
	for i := range out {
		w := windows[out[i].UserID]
		totals, e := w.totals()
		if e != nil {
			return nil, nil, e
		}
		out[i].UsedBytes = totals.WeightedBytes
		out[i].CycleID = w.Start.UTC().Format(time.RFC3339Nano)
	}
	return recipients, out, nil
}
