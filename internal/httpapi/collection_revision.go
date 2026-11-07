package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"routeweaver/internal/store"
)

// Omission preserves legacy collection upserts. A supplied precondition must
// identify the complete opened recipe, and this same snapshot fences the write.
func (h *server) expectedCollectionRecord(r *http.Request, owner, id string) (*store.RecordCompare, error) {
	kind := store.TenantKind(owner, "collections")
	var raw json.RawMessage
	err := h.s.Get(kind, id, &raw)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
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
	if errors.Is(err, store.ErrConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "COLLECTION_DRAFT_CHANGED",
			"message": "集合或来源已变化，当前输入未保存。请保留当前输入，或放弃修改后重新打开最新版本。",
		})
		return
	}
	storeError(w, err)
}
