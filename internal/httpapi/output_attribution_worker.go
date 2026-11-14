package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/store"
)

func (h *server) registerAttributedOutputLifecycle(r chi.Router) {
	r.Get("/outputs/independent", func(w http.ResponseWriter, r *http.Request) {
		owner := current(r).Account.ID
		records, _, err := h.s.ListOutputAttributionIntents(owner)
		if err != nil {
			fail(w, 503, "subscription provisioning history unavailable")
			return
		}
		items := make([]map[string]any, 0, len(records))
		for _, record := range records {
			raw, ok := record.Expected.(json.RawMessage)
			var in attributedOutputIntent
			if !ok || json.Unmarshal(raw, &in) != nil || in.Owner != owner || in.ID != record.ID {
				fail(w, 503, "subscription provisioning history unavailable")
				return
			}
			items = append(items, attributionIntentView(in))
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, map[string]any{"items": items})
	})

	r.Get("/outputs/independent/{id}", func(w http.ResponseWriter, r *http.Request) {
		var in attributedOutputIntent
		if err := h.s.TenantGet(current(r).Account.ID, "output-attribution-intents", chi.URLParam(r, "id"), &in); err != nil {
			storeError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, attributionIntentView(in))
	})
	r.Post("/outputs/independent/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		owner, id := current(r).Account.ID, chi.URLParam(r, "id")
		var in attributedOutputIntent
		var raw json.RawMessage
		kind := store.TenantKind(owner, "output-attribution-intents")
		if err := h.s.Get(kind, id, &raw); err != nil {
			storeError(w, err)
			return
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			storeError(w, err)
			return
		}
		var existing Output
		var expected any
		if err := h.s.TenantGet(owner, "outputs", id, &existing); err == nil {
			if existing.Attribution == nil || existing.Attribution.Revision != in.Revision {
				fail(w, 409, "output identity changed")
				return
			}
			expected = existing
		} else if err != store.ErrNotFound {
			storeError(w, err)
			return
		}
		if err := h.s.CompareInputsAndCancelAttributedOutput(owner, id, in.Revision, expected, []store.RecordCompare{{Kind: kind, ID: id, Expected: raw}}, nil); err != nil {
			storeError(w, err)
			return
		}
		in.State = "cancelling"
		writeJSON(w, 202, attributionIntentView(in))
	})
}
func (h *server) compensateAttributedOutput(in attributedOutputIntent, raw json.RawMessage) (attributedOutputIntent, error) {
	kind := store.TenantKind(in.Owner, "output-attribution-intents")
	// All acquisition paths use the same deployment ordering. Locks remain held
	// until every compensation finishes; randomized map order can deadlock two
	// concurrent cancellations across shared deployments.
	for _, dep := range orderedAttributionDeployments(in.MigrationIDs) {
		migrationID := in.MigrationIDs[dep]
		var original principalServiceMigration
		if err := h.s.Get("principal-service-migrations", migrationID, &original); err == store.ErrNotFound {
			continue
		} else if err != nil {
			return in, err
		}
		if original.Owner != in.Owner || original.OutputID != in.ID || original.OutputRevision != in.Revision {
			return in, fmt.Errorf("compensation identity mismatch")
		}
		if original.State == "compensated" {
			continue
		}
		compID := principalCompensationID(migrationID)
		var receipt principalServiceMigration
		err := h.s.Get("principal-service-migrations", compID, &receipt)
		if err == store.ErrNotFound {
			prepared, err := h.preparePrincipalServiceCompensation(in.Owner, migrationID)
			if err != nil {
				return in, err
			}
			if err := h.queuePrincipalServiceCompensation(prepared, []store.RecordCompare{{Kind: kind, ID: in.ID, Expected: raw}}, nil); err != nil {
				return in, err
			}
			return in, nil
		}
		if err != nil {
			return in, err
		}
		state, err := h.reconcilePrincipalServiceMigration(in.Owner, compID)
		if err != nil {
			return in, err
		}
		if state != "applied" {
			return in, nil
		}
	}
	next := in
	next.State = "cancelled"
	next.UpdatedAt = time.Now().UTC()
	if err := h.s.CompareInputsAndFinishAttributedCancellation(in.Owner, in.ID, in.Revision, []store.RecordCompare{{Kind: kind, ID: in.ID, Expected: raw}}, nil); err != nil {
		return in, err
	}
	return next, nil
}

// RunIndependentOutputProvisioning resumes only explicitly reserved intents.
// All publication remains fenced by persisted default-off administrator scope.
// At most 20 encrypted queue entries are read per tick; no request keeps this
// worker alive, and shutdown is controlled by the control plane's context.
func RunIndependentOutputProvisioning(ctx context.Context, s *store.Store, opts Options) {
	h := &server{s: s, opts: opts}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	cursor := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		entries, err := s.ListOutputAttributionQueue(cursor, 20)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			select {
			case <-ctx.Done():
				return
			default:
			}
			cursor = entry.Key
			_, err := h.advanceAttributedOutput(entry.Owner, entry.OutputID)
			if err != nil {
				h.recordAttributedOutputRetry(entry.Owner, entry.OutputID, err)
				continue
			} // bounded retry; never log private artifacts
		}
		if len(entries) < 20 {
			cursor = ""
		}
	}
}

func (h *server) recordAttributedOutputRetry(owner, id string, cause error) {
	kind := store.TenantKind(owner, "output-attribution-intents")
	var raw json.RawMessage
	if h.s.Get(kind, id, &raw) != nil {
		return
	}
	var in attributedOutputIntent
	if json.Unmarshal(raw, &in) != nil {
		return
	}
	if in.State == "published" || in.State == "cancelled" {
		return
	}
	next := in
	if in.State == "cancelling" || in.State == "recovery_required" {
		next.FailureCode = "cleanup_requires_runtime_evidence"
	} else {
		next.FailureCode = "waiting_for_confirmed_service"
		if errors.Is(cause, ErrPrincipalMigrationRateLimited) {
			next.FailureCode = "waiting_for_rate_limit"
		}
	}
	if next.State == in.State && next.FailureCode == in.FailureCode {
		return
	}
	next.UpdatedAt = time.Now().UTC()
	_ = h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: kind, ID: id, Expected: raw}}, []store.RecordWrite{{Kind: kind, ID: id, Value: next}})
}

func orderedAttributionDeployments(migrations map[string]string) []string {
	ids := make([]string, 0, len(migrations))
	for id := range migrations {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
