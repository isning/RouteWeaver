package httpapi

import (
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"net/http"
	"strings"
)

// Summary objects are intentionally not writable drafts. Secrets are omitted,
// not replaced with plausible credentials; explicit reveal returns an editable
// record and the server always fingerprints the full persisted deployment.
func serverSummary(value any) any {
	raw, e := json.Marshal(value)
	if e != nil {
		return nil
	}
	var tree any
	if json.Unmarshal(raw, &tree) != nil {
		return nil
	}
	omitServerSecrets(tree)
	return tree
}
func omitServerSecrets(tree any) {
	switch value := tree.(type) {
	case map[string]any:
		for key, child := range value {
			normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(key))
			switch normalized {
			case "username", "password", "passwd", "uuid", "privatekey", "privatekeypem", "certificatepem", "shortid", "shortids", "headers":
				delete(value, key)
			default:
				omitServerSecrets(child)
			}
		}
	case []any:
		for _, child := range value {
			omitServerSecrets(child)
		}
	}
}
func (h *server) registerSecretInventoryRead(r chi.Router, kind string) {
	r.Get("/"+kind, func(w http.ResponseWriter, r *http.Request) {
		records, e := h.s.List(kind)
		if e != nil {
			storeError(w, e)
			return
		}
		views := []any{}
		for _, raw := range records {
			var identity struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(raw, &identity) != nil {
				fail(w, 500, "cannot read inventory")
				return
			}
			views = append(views, h.revisionView(kind, identity.ID, raw, false))
		}
		writeJSON(w, 200, views)
	})
	r.Get("/"+kind+"/{id}", func(w http.ResponseWriter, r *http.Request) {
		var record json.RawMessage
		if e := h.s.Get(kind, chi.URLParam(r, "id"), &record); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, h.revisionView(kind, chi.URLParam(r, "id"), record, false))
	})
	r.Get("/"+kind+"/{id}/reveal", func(w http.ResponseWriter, r *http.Request) {
		var record json.RawMessage
		id := chi.URLParam(r, "id")
		if e := h.s.Get(kind, id, &record); e != nil {
			storeError(w, e)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		h.s.Audit(current(r).Account.ID, "inventory.secret-revealed", kind+"/"+id)
		writeJSON(w, 200, h.revisionView(kind, id, record, true))
	})
}
