package httpapi

import (
	"encoding/json"
	"sort"

	"routeweaver/internal/store"
)

type tenantRecordReader interface {
	TenantGet(owner, kind, id string, out any) error
}

// templateInputs is the shared input manifest for template and output reviews.
// It retains the exact private tenant inputs consumed by rendering. The
// same record is never read twice at different versions within one candidate.
// Only their digest is returned; credentials remain inside the server.
type templateInputs struct {
	s       *store.Store
	records map[string]store.RecordCompare
	sets    []store.RecordSetCompare
}

func newTemplateInputs(s *store.Store) *templateInputs {
	return &templateInputs{s: s, records: map[string]store.RecordCompare{}}
}

func (m *templateInputs) TenantGet(owner, kind, id string, out any) error {
	kind = store.TenantKind(owner, kind)
	key := kind + "\x00" + id
	if c, ok := m.records[key]; ok {
		return json.Unmarshal(c.Expected.(json.RawMessage), out)
	}
	var raw json.RawMessage
	if err := m.s.Get(kind, id, &raw); err != nil {
		return err
	}
	m.records[key] = store.RecordCompare{Kind: kind, ID: id, Expected: raw}
	return json.Unmarshal(raw, out)
}

func (m *templateInputs) profiles(owner string) ([]json.RawMessage, error) {
	kind := store.TenantKind(owner, "profiles")
	raws, err := m.s.List(kind)
	if err != nil {
		return nil, err
	}
	set := store.RecordSetCompare{Kind: kind, IDs: []string{}}
	for _, raw := range raws {
		var p Profile
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		set.IDs = append(set.IDs, p.ID)
		m.records[kind+"\x00"+p.ID] = store.RecordCompare{Kind: kind, ID: p.ID, Expected: raw}
	}
	m.sets = append(m.sets, set)
	return raws, nil
}

func (m *templateInputs) compares() []store.RecordCompare {
	keys := make([]string, 0, len(m.records))
	for key := range m.records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]store.RecordCompare, 0, len(keys))
	for _, key := range keys {
		out = append(out, m.records[key])
	}
	return out
}
