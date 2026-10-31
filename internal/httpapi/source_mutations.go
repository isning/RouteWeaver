package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
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
		storeError(w, err)
		return
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
		if err == store.ErrConflict {
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
