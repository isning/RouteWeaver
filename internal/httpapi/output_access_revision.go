package httpapi

import (
	"errors"
	"net/http"

	"routeweaver/internal/store"
)

// This owner/output-scoped keyed token describes the complete opened output,
// including its bearer credential and publication. It exposes neither. Unlike
// publication Revision, it changes on rotation as well as revoke/republish.
func (h *server) outputAccessRevision(owner string, output Output) string {
	return h.recordRevision(store.TenantKind(owner, "outputs"), output.ID, output)
}

// Omission deliberately preserves the legacy API's current-record mutation.
// An explicitly supplied header is never downgraded to that compatibility path.
// The caller must retain this exact output as the transaction's CAS snapshot.
func (h *server) checkOutputAccessRevision(w http.ResponseWriter, r *http.Request, owner string, output Output) bool {
	if matches, supplied := r.Header["If-Match"]; supplied {
		if len(matches) != 1 || !sameReviewToken(matches[0], h.outputAccessRevision(owner, output)) {
			outputAccessMutationError(w, store.ErrConflict)
			return false
		}
	}
	return true
}

func outputAccessMutationError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":   "OUTPUT_ACCESS_CHANGED",
			"detail": "订阅访问方式已变化，此操作未执行。请重新打开订阅后再确认。",
		})
		return
	}
	storeError(w, err)
}
