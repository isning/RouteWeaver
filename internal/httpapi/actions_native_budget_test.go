package httpapi_test

import (
	"fmt"
	"reflect"
	"routeweaver/internal/domain"
	"strings"
	"testing"

	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestActionsCompareSmallNativeJSONWithoutPublishing(t *testing.T) {
	for _, adapter := range []string{"mihomo", "sing-box"} {
		t.Run(adapter, func(t *testing.T) {
			s, srv := makeServer(t)
			owner := inviteClient(t, s, srv, "native-actions")
			other := inviteClient(t, s, srv, "native-actions-other")
			target := render.Target{AdapterID: adapter, Version: render.MihomoVersion}
			initial, changed := `{"tcp-concurrent":true}`, `{"tcp-concurrent":false}`
			if adapter == "sing-box" {
				target.Version = render.SingBoxVersion
				initial, changed = `{"log":{"level":"info"}}`, `{"log":{"level":"debug"}}`
			}
			p := nativeProfile(target, initial)
			code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]any{"id": "native-output", "name": "Native", "profileId": p.ID, "target": target})
			if code != 201 {
				t.Fatal(raw)
			}
			var before httpapi.Output
			if err := s.TenantGet(owner.id, "outputs", "native-output", &before); err != nil {
				t.Fatal(err)
			}
			read := func(wantChanged, partial bool) {
				t.Helper()
				code, v, raw := req(t, owner.c, "GET", srv.URL+"/api/me/actions", "", nil)
				if code != 200 || v["partial"] != partial {
					t.Fatal(raw)
				}
				items, unchecked := v["items"].([]any), v["uncheckedOutputs"].([]any)
				if wantChanged {
					if len(items) != 1 || items[0].(map[string]any)["kind"] != "output-changed" {
						t.Fatal(raw)
					}
				} else if len(items) != 0 {
					t.Fatal(raw)
				}
				if partial != (len(unchecked) == 1) {
					t.Fatal(raw)
				}
				if partial && (unchecked[0].(map[string]any)["id"] != before.ID || unchecked[0].(map[string]any)["revision"] != before.Revision) {
					t.Fatalf("unchecked observation lost publication identity: %s", raw)
				}
				if strings.Contains(raw, "tcp-concurrent") || strings.Contains(raw, "private-dns.example") {
					t.Fatal("raw native content leaked")
				}
			}
			read(false, false)
			p.IR.NativeOverride.Content = changed
			if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
				t.Fatal(err)
			}
			read(true, false)
			// The published target, not a new draft envelope version, is authoritative.
			p.IR.NativeOverride.Target.Version = "unverified-version"
			if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
				t.Fatal(err)
			}
			read(false, true)
			p.IR.NativeOverride.Target.Version = target.Version
			// Source materialization must not bypass the render budget even when the
			// stored profile itself has only one endpoint.
			endpoints := make([]domain.ClientEndpoint, 33)
			for i := range endpoints {
				endpoints[i] = p.IR.Endpoints[0]
				endpoints[i].ID = fmt.Sprintf("source-node-%d", i)
				endpoints[i].Name = fmt.Sprintf("Source node %d", i)
				endpoints[i].OwnerID = owner.id
			}
			source := httpapi.Source{ID: "materialized", OwnerID: owner.id, Enabled: true, Snapshot: &domain.SourceSnapshot{SourceID: "materialized", SnapshotID: "saved", OwnerID: owner.id, Endpoints: endpoints}}
			if err := s.TenantPut(owner.id, "sources", source.ID, source); err != nil {
				t.Fatal(err)
			}
			p.SourceIDs = []string{source.ID}
			if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
				t.Fatal(err)
			}
			read(false, true)
			code, selected, raw := req(t, owner.c, "GET", srv.URL+"/api/me/outputs/native-output/status", "", nil)
			if code != 200 || selected["draftComparison"].(map[string]any)["state"] != "changed" {
				t.Fatalf("explicit comparison lost its existing capacity: %d %s", code, raw)
			}
			p.SourceIDs = nil
			for _, content := range []string{
				strings.Repeat(" ", 4097) + changed,
				`{"dns":` + strings.Repeat(`{"x":`, 9) + `true` + strings.Repeat(`}`, 9) + `}`,
				`{"dns":[` + strings.Repeat(`0,`, 256) + `0]}`,
				`{"tcp-concurrent":true,"tcp-concurrent":false}`,
				`{"dns":{"nameserver":["https://private-dns.example/query"]}`,
			} {
				p.IR.NativeOverride.Content = content
				if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
					t.Fatal(err)
				}
				read(false, true)
			}
			p.IR.NativeOverride.Content, p.IR.NativeOverride.Format = "tcp-concurrent: false", "yaml"
			if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
				t.Fatal(err)
			}
			read(false, true)
			// A failed observation is not cached as healthy, and a corrected saved
			// draft is checked again without publishing or rewriting its revision.
			p.IR.NativeOverride.Content, p.IR.NativeOverride.Format = changed, "json"
			if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
				t.Fatal(err)
			}
			read(true, false)
			p.IR.OwnerID = other.id
			if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
				t.Fatal(err)
			}
			read(false, true)
			p.IR.OwnerID = owner.id
			if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
				t.Fatal(err)
			}
			read(true, false)
			code, v, raw := req(t, other.c, "GET", srv.URL+"/api/me/actions", "", nil)
			if code != 200 || len(v["items"].([]any)) != 0 || v["partial"] != false {
				t.Fatal(raw)
			}
			var after httpapi.Output
			if err := s.TenantGet(owner.id, "outputs", "native-output", &after); err != nil || !reflect.DeepEqual(before, after) {
				t.Fatal("comparison mutated publication")
			}
		})
	}
}
