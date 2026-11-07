package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"routeweaver/internal/store"
)

var (
	errCollectionCreationPrecondition = errors.New("collection creation requires a single If-None-Match: * precondition")
	errCollectionCreationConflict     = errors.New("collection already exists; reopen it before saving")
)

// Omission preserves legacy collection upserts. If-Match identifies the opened
// recipe; POST If-None-Match: * requires absence. The same snapshot fences writes.
func (h *server) expectedCollectionRecord(r *http.Request, owner, id string) (*store.RecordCompare, error) {
	createOnly := false
	if r.Method == http.MethodPost {
		if conditions, supplied := r.Header["If-None-Match"]; supplied {
			if len(conditions) != 1 || strings.Trim(conditions[0], " \t") != "*" {
				return nil, errCollectionCreationPrecondition
			}
			createOnly = true
		}
	}
	kind := store.TenantKind(owner, "collections")
	var raw json.RawMessage
	err := h.s.Get(kind, id, &raw)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	// Reject retries before resolving sources. If absent, the same snapshot
	// remains an expected-absent fence in the atomic collection/source commit.
	if createOnly && err == nil {
		return nil, errCollectionCreationConflict
	}
	if matches, supplied := r.Header["If-Match"]; supplied {
		if len(matches) != 1 || err != nil || !sameReviewToken(matches[0], h.recordRevision(kind, id, raw)) {
			return nil, store.ErrConflict
		}
	}
	var expected any
	if err == nil {
		expected = raw
	}
	return &store.RecordCompare{Kind: kind, ID: id, Expected: expected}, nil
}

func collectionSaveError(w http.ResponseWriter, err error) {
	if errors.Is(err, errCollectionCreationPrecondition) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "COLLECTION_CREATION_PRECONDITION_INVALID", "detail": errCollectionCreationPrecondition.Error()})
		return
	}
	if errors.Is(err, errCollectionCreationConflict) {
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{"code": "COLLECTION_CREATION_CONFLICT", "detail": errCollectionCreationConflict.Error()})
		return
	}
	if errors.Is(err, store.ErrConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "COLLECTION_DRAFT_CHANGED",
			"message": "集合或来源已变化，当前输入未保存。请保留当前输入，或放弃修改后重新打开最新版本。",
		})
		return
	}
	storeError(w, err)
}
