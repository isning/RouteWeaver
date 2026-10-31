package httpapi

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"routeweaver/internal/store"
)

func (h *server) recordRevision(kind, id string, value any) string {
	token, e := h.s.ReviewToken("record/"+kind+"/"+id, value)
	if e != nil {
		return ""
	}
	return token
}
func (h *server) revisionView(kind, id string, raw json.RawMessage, reveal bool) any {
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	if !reveal {
		omitServerSecrets(value)
	}
	if kind == "server-deployments" {
		value["revisionToken"] = h.recordRevision(kind, id, raw)
	}
	return value
}
func sameReviewToken(a, b string) bool {
	return a != "" && len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// Existing writers must carry the opened record's token. The snapshot returned
// here is also used in the transaction, so a successful check is never a lease.
func (h *server) expectedRecord(r *http.Request, kind, id string) (*store.RecordCompare, error) {
	var raw json.RawMessage
	e := h.s.Get(kind, id, &raw)
	if r.Method == http.MethodPost {
		if e == store.ErrNotFound {
			return &store.RecordCompare{Kind: kind, ID: id}, nil
		}
		if e != nil {
			return nil, e
		}
		return nil, store.ErrConflict
	}
	if e != nil {
		return nil, e
	}
	if !sameReviewToken(r.Header.Get("If-Match"), h.recordRevision(kind, id, raw)) {
		return nil, store.ErrConflict
	}
	return &store.RecordCompare{Kind: kind, ID: id, Expected: raw}, nil
}
func strictSupported(raw []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("stored intent contains unsupported fields or shape")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return fmt.Errorf("stored intent contains unsupported fields or shape")
	}
	return nil
}
