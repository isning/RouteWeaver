package httpapi

import (
	"encoding/json"
	"fmt"
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
		if c.Expected == nil {
			return store.ErrNotFound
		}
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

// expectRecord fences create/update against concurrent replacement or deletion.
func (m *templateInputs) expectRecord(owner, kind, id string) error {
	kind = store.TenantKind(owner, kind)
	var raw json.RawMessage
	err := m.s.Get(kind, id, &raw)
	if err != nil && err != store.ErrNotFound {
		return err
	}
	var expected any
	if err == nil {
		expected = raw
	}
	m.records[kind+"\x00"+id] = store.RecordCompare{Kind: kind, ID: id, Expected: expected}
	return nil
}

// TenantList fences both membership and values. Deletion must detect newly
// created dependants as well as edits that introduce a reference in an old row.
func (m *templateInputs) TenantList(owner, kind string) ([]json.RawMessage, error) {
	kind = store.TenantKind(owner, kind)
	raws, err := m.s.List(kind)
	if err != nil {
		return nil, err
	}
	set := store.RecordSetCompare{Kind: kind, IDs: []string{}}
	for _, raw := range raws {
		var identity struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &identity); err != nil {
			return nil, err
		}
		if identity.ID == "" {
			return nil, fmt.Errorf("cannot read relationship identity")
		}
		set.IDs = append(set.IDs, identity.ID)
		m.records[kind+"\x00"+identity.ID] = store.RecordCompare{Kind: kind, ID: identity.ID, Expected: raw}
	}
	m.sets = append(m.sets, set)
	return raws, nil
}
