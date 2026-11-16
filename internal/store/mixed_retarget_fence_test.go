package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func mixedFenceStore(t *testing.T) (*Store, *Store) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{73}, 32)
	s, e := Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	other, e := Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { other.Close(); s.Close() })
	for _, kind := range []string{"published-routes", "server-deployments"} {
		if e = s.Put(kind, "target", map[string]int{"version": 1}); e != nil {
			t.Fatal(e)
		}
	}
	return s, other
}
func mixedFenceCapture(t *testing.T, s *Store) *MixedRetargetFence {
	t.Helper()
	f, e := s.CaptureMixedRetargetFence(context.Background(), "target", "target", func(_, _ string, _ json.RawMessage) error { return nil })
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func mixedFenceCommit(s *Store, f *MixedRetargetFence) error {
	return s.CompareMixedRetargetAndPutRecords(context.Background(), f, []RecordCompare{{Kind: "published-routes", ID: "target", Expected: map[string]int{"version": 1}}, {Kind: "server-deployments", ID: "target", Expected: map[string]int{"version": 1}}}, nil, []RecordWrite{{Kind: "published-routes", ID: "target", Value: map[string]int{"version": 2}}, {Kind: "server-deployments", ID: "target", Value: map[string]int{"version": 2}}})
}
func TestMixedRetargetCanonicalMembershipFence(t *testing.T) {
	for _, change := range []string{"new-owner", "new-unrelated-tenant-kind", "value", "delete", "global-binding", "orphan-restored-grant"} {
		t.Run(change, func(t *testing.T) {
			s, other := mixedFenceStore(t)
			kind := TenantKind("owner", "output-attribution-intents")
			if e := s.Put(kind, "intent", map[string]string{"state": "cancelled"}); e != nil {
				t.Fatal(e)
			}
			f := mixedFenceCapture(t, s)
			switch change {
			case "new-owner":
				if e := other.Put(TenantKind("new-owner", "output-attribution-intents"), "new", map[string]string{"state": "reserved"}); e != nil {
					t.Fatal(e)
				}
			case "new-unrelated-tenant-kind":
				if e := other.Put(TenantKind("orphan", "profiles"), "new", map[string]string{"x": "y"}); e != nil {
					t.Fatal(e)
				}
			case "value":
				if e := other.Put(kind, "intent", map[string]string{"state": "published"}); e != nil {
					t.Fatal(e)
				}
			case "delete":
				if e := other.Remove(kind, "intent"); e != nil {
					t.Fatal(e)
				}
			case "global-binding":
				if e := other.Put("entry-admission-bindings", "core:entry:subject:version", map[string]string{"outputId": "output"}); e != nil {
					t.Fatal(e)
				}
			case "orphan-restored-grant":
				if e := other.Put(TenantKind("missing-account", "platform-entries"), "restored", map[string]string{"outputId": "output"}); e != nil {
					t.Fatal(e)
				}
			}
			if e := mixedFenceCommit(s, f); !errors.Is(e, ErrConflict) {
				t.Fatalf("expected conflict: %v", e)
			}
			for _, kind := range []string{"published-routes", "server-deployments"} {
				var got map[string]int
				if e := s.Get(kind, "target", &got); e != nil || got["version"] != 1 {
					t.Fatalf("partial mutation %s %v", kind, e)
				}
			}
		})
	}
}
func TestMixedRetargetClassifierCompleteAndImmutable(t *testing.T) {
	s, _ := mixedFenceStore(t)
	kinds := []string{TenantKind("orphan", "output-attribution-intents"), TenantKind("orphan", "platform-entries"), "entry-admission-bindings", "output-attribution-claims", "principal-service-migrations", "principal-provisioning-locks"}
	for _, kind := range kinds {
		if e := s.Put(kind, mixedFenceID(kind, "record"), map[string]string{"marker": "original"}); e != nil {
			t.Fatal(e)
		}
	}
	seen := map[string]bool{}
	f, e := s.CaptureMixedRetargetFence(context.Background(), "target", "target", func(kind, id string, raw json.RawMessage) error { seen[kind] = true; raw[0] = '!'; return nil })
	if e != nil {
		t.Fatal(e)
	}
	if len(seen) != len(kinds) {
		t.Fatal("canonical kind omitted")
	}
	if e = mixedFenceCommit(s, f); e != nil {
		t.Fatal(e)
	}
	_, e = s.CaptureMixedRetargetFence(context.Background(), "target", "target", func(_, _ string, _ json.RawMessage) error { return ErrMixedRetargetUnavailable })
	if !errors.Is(e, ErrMixedRetargetUnavailable) {
		t.Fatal("classifier refusal ignored")
	}
}
func TestMixedRetargetBudgetsAndMalformedRecords(t *testing.T) {
	for _, mode := range []string{"tenant-metadata", "selected-count", "large-record", "total-bytes", "invalid-tenant-kind", "duplicate-json", "deep-json"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := mixedFenceStore(t)
			switch mode {
			case "tenant-metadata":
				for i := 0; i < 257; i++ {
					if e := s.Put(TenantKind("owner", "profiles"), fmt.Sprintf("p%d", i), map[string]int{"v": i}); e != nil {
						t.Fatal(e)
					}
				}
			case "selected-count":
				for i := 0; i < 65; i++ {
					if e := s.Put("output-attribution-claims", fmt.Sprintf("core:entry:subject:c%d", i), map[string]int{"v": i}); e != nil {
						t.Fatal(e)
					}
				}
			case "large-record":
				if e := s.Put(TenantKind("owner", "output-attribution-intents"), "large", map[string]string{"v": strings.Repeat("x", 64<<10)}); e != nil {
					t.Fatal(e)
				}
			case "total-bytes":
				for i := 0; i < 40; i++ {
					if e := s.Put("output-attribution-claims", fmt.Sprintf("core:entry:subject:c%d", i), map[string]string{"v": strings.Repeat("x", 60<<10)}); e != nil {
						t.Fatal(e)
					}
				}
			case "invalid-tenant-kind":
				if e := s.Put("tenant/owner/nested/output-attribution-intents", "bad", map[string]int{"v": 1}); e != nil {
					t.Fatal(e)
				}
			case "duplicate-json":
				if e := s.Put("output-attribution-claims", "core:entry:subject:bad", json.RawMessage(`{"routeId":"other","routeId":"target"}`)); e != nil {
					t.Fatal(e)
				}
			case "deep-json":
				if e := s.Put("output-attribution-claims", "core:entry:subject:bad", json.RawMessage(`{"x":`+strings.Repeat("[", 34)+"1"+strings.Repeat("]", 34)+`}`)); e != nil {
					t.Fatal(e)
				}
			}
			_, e := s.CaptureMixedRetargetFence(context.Background(), "target", "target", func(_, _ string, _ json.RawMessage) error { return nil })
			if !errors.Is(e, ErrMixedRetargetUnavailable) {
				t.Fatalf("expected bounded refusal %v", e)
			}
		})
	}
}
func TestMixedRetargetUsesIndexedRangePlans(t *testing.T) {
	s, _ := mixedFenceStore(t)
	for _, q := range []string{`SELECT length(kind),length(id),length(data) FROM records WHERE kind >= 'tenant/' AND kind < 'tenant0' ORDER BY kind,id LIMIT 257`, `SELECT length(kind),length(id),length(data) FROM records WHERE kind='output-attribution-claims' ORDER BY kind,id LIMIT 65`} {
		rows, e := s.db.Query("EXPLAIN QUERY PLAN " + q)
		if e != nil {
			t.Fatal(e)
		}
		plan := ""
		for rows.Next() {
			var a, b, c int
			var detail string
			if e = rows.Scan(&a, &b, &c, &detail); e != nil {
				t.Fatal(e)
			}
			plan += detail
		}
		rows.Close()
		if !strings.Contains(plan, "SEARCH records USING INDEX") || strings.Contains(plan, "SCAN records") {
			t.Fatalf("unbounded plan %s", plan)
		}
	}
}
func TestMixedRetargetCannotForgeOrBroadenWriter(t *testing.T) {
	s, other := mixedFenceStore(t)
	if e := mixedFenceCommit(s, &MixedRetargetFence{}); !errors.Is(e, ErrMixedRetargetUnavailable) {
		t.Fatal(e)
	}
	f := mixedFenceCapture(t, s)
	if e := mixedFenceCommit(other, f); !errors.Is(e, ErrMixedRetargetUnavailable) {
		t.Fatal(e)
	}
	if e := s.CompareMixedRetargetAndPutRecords(context.Background(), f, nil, nil, nil); !errors.Is(e, ErrMixedRetargetUnavailable) {
		t.Fatal(e)
	}
}

func mixedFenceID(kind, id string) string {
	if kind == "entry-admission-bindings" || kind == "output-attribution-claims" {
		return "core:entry:subject:" + id
	}
	return id
}

func TestMixedRetargetCancelledCaptureAndCommit(t *testing.T) {
	s, _ := mixedFenceStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.CaptureMixedRetargetFence(ctx, "target", "target", func(_, _ string, _ json.RawMessage) error { return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("capture cancellation: %v", err)
	}
	f := mixedFenceCapture(t, s)
	err := s.CompareMixedRetargetAndPutRecords(ctx, f, []RecordCompare{{Kind: "published-routes", ID: "target", Expected: map[string]int{"version": 1}}, {Kind: "server-deployments", ID: "target", Expected: map[string]int{"version": 1}}}, nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("commit cancellation: %v", err)
	}
}
