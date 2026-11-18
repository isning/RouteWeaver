package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/auth"
	"routeweaver/internal/importer"
	"routeweaver/internal/resources"
	"routeweaver/internal/store"
)

// These source-local sentinels preserve the existing redacted HTTP detail while
// providing stable classification independent of English presentation strings.
var (
	errSourceParse      = errors.New("source parse failed; check the supported input format and resolve ambiguous changed entries")
	errSourceIncomplete = errors.New("source could not be imported completely; previous accepted snapshot retained")
)

func sourceFailureCode(err error) string {
	switch {
	case errors.Is(err, resources.ErrURL):
		return "source_url_not_allowed"
	case errors.Is(err, resources.ErrAddress):
		return "source_address_not_public"
	case errors.Is(err, resources.ErrTooLarge):
		return "source_content_too_large"
	case errors.Is(err, context.DeadlineExceeded):
		return "source_fetch_timeout"
	case errors.Is(err, resources.ErrFetch):
		return "source_fetch_failed"
	case errors.Is(err, errSourceParse):
		return "source_parse_failed"
	case errors.Is(err, errSourceIncomplete):
		return "source_import_incomplete"
	default:
		return ""
	}
}

func knownSourceFailureCode(code string) bool {
	switch code {
	case "source_url_not_allowed", "source_address_not_public", "source_content_too_large", "source_fetch_timeout", "source_fetch_failed", "source_parse_failed", "source_import_incomplete":
		return true
	default:
		return false
	}
}

func (h *server) saveSource(w http.ResponseWriter, r *http.Request) {
	createOnly := false
	if r.Method == http.MethodPost {
		if conditions, supplied := r.Header["If-None-Match"]; supplied {
			if len(conditions) != 1 || strings.Trim(conditions[0], " \t") != "*" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"code": "SOURCE_CREATION_PRECONDITION_INVALID", "detail": "source creation requires a single If-None-Match: * precondition"})
				return
			}
			createOnly = true
		}
	}
	owner := current(r).Account.ID
	var v Source
	if !decode(w, r, &v) {
		return
	}
	if err := ensureID(&v.ID); err != nil {
		storeError(w, err)
		return
	}
	if !pathMatches(r, v.ID) || v.Name == "" || (v.Kind != "text" && v.Kind != "url") {
		fail(w, 400, "source id, name and kind required")
		return
	}
	if err := sameOwner(&v.OwnerID, owner); err != nil {
		fail(w, 403, err.Error())
		return
	}
	var old Source
	var raw json.RawMessage
	err := h.s.TenantGet(owner, "sources", v.ID, &raw)
	if err != nil && err != store.ErrNotFound {
		storeError(w, err)
		return
	}
	// A guarded stable-ID retry must not replace a newer source or fetch its
	// submitted URL. A missing record remains fenced as expected-absent at commit.
	if createOnly && err == nil {
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{"code": "SOURCE_CREATION_CONFLICT", "detail": "source already exists; reopen it before saving"})
		return
	}
	if err == nil && json.Unmarshal(raw, &old) != nil {
		fail(w, 500, "cannot read source")
		return
	}
	if v.Revision != "" && v.Revision != old.Revision {
		fail(w, 409, "source changed; reopen it before saving")
		return
	}
	if chi.URLParam(r, "id") != "" && err == store.ErrNotFound {
		storeError(w, store.ErrNotFound)
		return
	}
	if v.ApplyMode == "" {
		v.ApplyMode = sourceApplyMode(old.ApplyMode)
	}
	if !validSourceApplyMode(v.ApplyMode) {
		fail(w, 400, "source applyMode must be auto or manual")
		return
	}
	if v.RefreshIntervalSeconds == 0 {
		v.RefreshIntervalSeconds = old.RefreshIntervalSeconds
	}
	if !validSubscriptionInterval(v.RefreshIntervalSeconds) {
		fail(w, 400, "unsupported subscription refresh interval")
		return
	}
	v.ApplyHistory = old.ApplyHistory
	v.Snapshot = old.Snapshot
	v.Candidate = nil
	v.Diagnostics = old.Diagnostics
	v.LastError = ""
	v.UpdatedAt = old.UpdatedAt
	if v.Format == "" {
		v.Format = "auto"
	}
	h.applySourceInput(w, r, raw, old, v)
}
func (h *server) refreshSource(w http.ResponseWriter, r *http.Request) {
	var raw json.RawMessage
	if err := h.s.TenantGet(current(r).Account.ID, "sources", chi.URLParam(r, "id"), &raw); err != nil {
		storeError(w, err)
		return
	}
	var v Source
	if json.Unmarshal(raw, &v) != nil {
		fail(w, 500, "cannot read source")
		return
	}
	v.ApplyMode = sourceApplyMode(v.ApplyMode)
	if !validSourceApplyMode(v.ApplyMode) {
		fail(w, 400, "source applyMode must be auto or manual")
		return
	}
	if !v.Enabled {
		fail(w, 409, "source is paused; enable it before refreshing")
		return
	}
	old := v
	v.Candidate = nil
	v.LastError = ""
	h.applySourceInput(w, r, raw, old, v)
}
func (h *server) applySourceInput(w http.ResponseWriter, r *http.Request, raw json.RawMessage, old, v Source) {

	v, status, err := h.executeSourceInput(r, raw, old, v)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			fail(w, 409, "source or affected selections changed while checking; retry with the current source")
		} else {
			storeError(w, err)
		}
		return
	}
	if status == 422 {
		writeJSON(w, status, map[string]any{"detail": v.LastError, "source": sourceView(v, false)})
		return
	}
	writeJSON(w, status, sourceView(v, false))
}
func (h *server) executeSourceInput(r *http.Request, raw json.RawMessage, old, v Source) (Source, int, error) {
	// Never trust submitted or previously persisted failure classification. Each
	// attempt, including pause and success, derives its own server-owned state.
	v.LastErrorCode = ""
	inputs := newTemplateInputs(h.s)
	var expected any
	if len(raw) > 0 {
		expected = raw
	}
	inputs.records[store.TenantKind(v.OwnerID, "sources")+"\x00"+v.ID] = store.RecordCompare{Kind: store.TenantKind(v.OwnerID, "sources"), ID: v.ID, Expected: expected}
	revision, err := auth.Token()
	if err != nil {
		return v, 500, err
	}
	v.Revision = "sr_" + revision
	status := http.StatusOK
	if v.Enabled {
		checked := time.Now().UTC()
		v.CheckedAt = &checked
		err = h.parseSource(r, &v)
		if err == nil {
			err = h.prepareSourceUpdate(old, &v, inputs)
		}
		if err != nil {
			v.Snapshot = old.Snapshot
			v.Candidate = nil
			v.Diagnostics = old.Diagnostics
			v.LastError = err.Error()
			v.LastErrorCode = sourceFailureCode(err)
			v.RefreshStatus = "failed"
			v.UpdatedAt = old.UpdatedAt
			status = 422
		}
	} else {
		v.RefreshStatus = "paused"
		v.CheckedAt = old.CheckedAt
	}
	if err := h.s.CompareSetsAndPutRecords(inputs.compares(), inputs.sets, []store.RecordWrite{{Kind: store.TenantKind(v.OwnerID, "sources"), ID: v.ID, Value: v}}); err != nil {
		return v, 0, err
	}
	return v, status, nil
}

func (h *server) parseSource(r *http.Request, v *Source) error {
	text := v.Content
	if v.Kind == "url" {
		fetched, err := resources.New(resources.Options{MaxBytes: 2 << 20, Timeout: 15 * time.Second}).Fetch(r.Context(), v.URL)
		if err != nil {
			return err
		}
		text = string(fetched.Body)
	}
	snapshot, err := auth.Token()
	if err != nil {
		return err
	}
	parsed, err := importer.Parse(importer.Request{SourceID: v.ID, SourceName: v.Name, SnapshotID: "s_" + snapshot, OwnerID: v.OwnerID, Format: v.Format, Data: []byte(text), Previous: v.Snapshot})
	if err != nil {
		return errSourceParse
	}
	if !parsed.Complete {
		return errSourceIncomplete
	}
	v.Snapshot = &parsed.Snapshot
	v.Diagnostics = parsed.Warnings
	v.LastError = ""
	return nil
}

// RunSourceSubscriptions refreshes URL sources hourly, independently of open UI sessions.
// Work is serialized; pending reviews and accepted snapshots survive retries and restarts.
func RunSourceSubscriptions(ctx context.Context, s *store.Store) {
	h := &server{s: s}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		h.refreshDueSubscriptions(ctx, time.Now().UTC())
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (h *server) refreshDueSubscriptions(ctx context.Context, now time.Time) {
	accounts, err := h.s.List("accounts")
	if err != nil {
		return
	}
	for _, rawAccount := range accounts {
		var account store.Account
		if json.Unmarshal(rawAccount, &account) != nil || account.Disabled || account.Retired {
			continue
		}
		records, err := h.s.TenantList(account.ID, "sources")
		if err != nil {
			continue
		}
		for _, raw := range records {
			if ctx.Err() != nil {
				return
			}
			var source Source
			if json.Unmarshal(raw, &source) != nil || source.OwnerID != account.ID || !subscriptionDue(source, now) {
				continue
			}
			before := source
			source.LastError = ""
			attempt, cancel := context.WithTimeout(ctx, 20*time.Second)
			request, err := http.NewRequestWithContext(attempt, http.MethodGet, "http://localhost/", nil)
			if err == nil {
				_, _, _ = h.executeSourceInput(request, raw, before, source)
			}
			cancel()
		}
	}
}

func subscriptionDue(source Source, now time.Time) bool {
	return source.Kind == "url" && source.Enabled && source.Candidate == nil &&
		validSourceApplyMode(sourceApplyMode(source.ApplyMode)) &&
		(source.CheckedAt == nil || !now.Before(source.CheckedAt.Add(subscriptionInterval(source.RefreshIntervalSeconds))))
}

func validSubscriptionInterval(seconds int) bool {
	switch seconds {
	case 0, 900, 1800, 3600, 21600, 43200, 86400:
		return true
	}
	return false
}
func subscriptionInterval(seconds int) time.Duration {
	if !validSubscriptionInterval(seconds) || seconds == 0 {
		return time.Hour
	}
	return time.Duration(seconds) * time.Second
}
