package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"routeweaver/internal/store"
)

// Revision tokens describe the complete private saved draft, not the redacted
// display copy. They are scoped to the tenant and record, and never persisted.
// Older backups therefore acquire tokens on read without a schema migration.
func (h *server) tenantRecordView(owner, kind string, raw json.RawMessage, reveal bool) json.RawMessage {
	view := raw
	if !reveal {
		view = redactTenantRecord(kind, raw)
	}
	if kind != "profiles" {
		return view
	}
	var value map[string]any
	if json.Unmarshal(view, &value) != nil {
		return view
	}
	id, _ := value["id"].(string)
	value["revisionToken"] = h.recordRevision(store.TenantKind(owner, kind), id, raw)
	out, _ := json.Marshal(value)
	return out
}

func profileSaveError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrConflict) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code":    "PROFILE_DRAFT_CHANGED",
			"message": "配置草稿已变化，当前输入未保存。请保留当前输入，或放弃修改后重新打开最新版本。",
		})
		return
	}
	storeError(w, err)
}
