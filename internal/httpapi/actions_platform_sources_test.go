package httpapi_test

import (
	"fmt"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

// The public actions endpoint consumes accepted snapshots, never refreshes URLs
// or candidate imports, and never changes the already published output.
func TestActionsPlatformSavedSourcesAndCollection(t *testing.T) {
	for _, adapter := range []string{"mihomo", "sing-box"} {
		for _, collection := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/collection=%v", adapter, collection), func(t *testing.T) {
				s, srv := makeServer(t)
				owner := inviteClient(t, s, srv, "platform-source")
				if err := s.Put("routes", "r", domain.Route{ID: "r", Name: "Route", UserIDs: []string{owner.id}}); err != nil {
					t.Fatal(err)
				}
				grant := httpapi.PublicEntryGrant{ID: "entry", Name: "Entry", UserID: owner.id, RouteID: "r", CredentialVersion: "v1", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.10", Port: 1080}}
				put := func(kind, id string, v any) {
					t.Helper()
					if err := s.TenantPut(owner.id, kind, id, v); err != nil {
						t.Fatal(err)
					}
				}
				put("platform-entries", "entry", grant)
				source := httpapi.Source{ID: "source", Name: "Accepted", OwnerID: owner.id, Enabled: true, Kind: "url", URL: "https://invalid.invalid/do-not-fetch", Snapshot: &domain.SourceSnapshot{SourceID: "source", SnapshotID: "snapshot", SourceName: "Accepted", OwnerID: owner.id, Endpoints: []domain.ClientEndpoint{{ID: "imported", Name: "Imported", OwnerID: owner.id, Origin: "imported", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.20", Port: 1080}}}}}
				put("sources", "source", source)
				c := domain.Collection{ID: "collection", Name: "Collection", OwnerID: owner.id, Sources: []domain.CollectionSource{{SourceID: "source"}}, Steps: []domain.ProcessingStep{{ID: "rename", Kind: "rename", Enabled: true, Template: "{name} processed"}}}
				put("collections", "collection", c)
				target := render.Target{AdapterID: adapter, Version: render.MihomoVersion}
				if adapter == "sing-box" {
					target.Version = render.SingBoxVersion
				}
				p := httpapi.Profile{ID: "p", Name: "Profile", Target: target, Mode: render.FullConfig, PlatformEntryIDs: []string{"entry"}, SourceIDs: []string{"source"}, IR: domain.ClientProfileIR{SchemaVersion: "1.0", DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: "entry"}}}
				if collection {
					p.SourceIDs = nil
					p.CollectionID = "collection"
				}
				if code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p); code != 200 {
					t.Fatal(raw)
				}
				if code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]string{"id": "o", "name": "Output", "profileId": "p"}); code != 201 {
					t.Fatal(raw)
				}
				var published httpapi.Output
				if err := s.TenantGet(owner.id, "outputs", "o", &published); err != nil {
					t.Fatal(err)
				}
				check := func(changed, unchecked bool) {
					t.Helper()
					code, v, raw := req(t, owner.c, "GET", srv.URL+"/api/me/actions", "", nil)
					if code != 200 || v["partial"] != unchecked {
						t.Fatal(raw)
					}
					found := false
					for _, item := range v["items"].([]any) {
						if item.(map[string]any)["kind"] == "output-changed" {
							found = true
						}
					}
					if found != changed || (len(v["uncheckedOutputs"].([]any)) == 1) != unchecked {
						t.Fatal(raw)
					}
					var after httpapi.Output
					if err := s.TenantGet(owner.id, "outputs", "o", &after); err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(published, after) {
						t.Fatal("automatic comparison changed publication")
					}
				}
				check(false, false)
				source.Snapshot.Endpoints[0].Connection.Port = 1081
				put("sources", "source", source)
				check(true, false)
				for _, mode := range []string{"source-id", "owner", "snapshot-id", "snapshot-owner", "disabled", "missing-snapshot", "large-name", "too-many-endpoints"} {
					bad := source
					snap := *source.Snapshot
					bad.Snapshot = &snap
					snap.Endpoints = append([]domain.ClientEndpoint(nil), source.Snapshot.Endpoints...)
					switch mode {
					case "source-id":
						bad.ID = "other"
					case "owner":
						bad.OwnerID = "other"
					case "snapshot-id":
						snap.SourceID = "other"
					case "snapshot-owner":
						snap.OwnerID = "other"
					case "disabled":
						bad.Enabled = false
					case "missing-snapshot":
						bad.Snapshot = nil
					case "large-name":
						snap.Endpoints[0].Name = strings.Repeat("x", 161)
					case "too-many-endpoints":
						for i := 1; i < 33; i++ {
							e := snap.Endpoints[0]
							e.ID = fmt.Sprintf("imported%d", i)
							snap.Endpoints = append(snap.Endpoints, e)
						}
					}
					put("sources", "source", bad)
					check(false, true)
					put("sources", "source", source)
					check(true, false)
				}
				if collection {
					for _, mode := range []string{"id", "owner", "steps", "template", "sources"} {
						bad := c
						switch mode {
						case "id":
							bad.ID = "other"
						case "owner":
							bad.OwnerID = "other"
						case "steps":
							bad.Steps = make([]domain.ProcessingStep, 33)
						case "template":
							bad.Steps = []domain.ProcessingStep{{ID: "rename", Enabled: true, Kind: "rename", Template: strings.Repeat("x", 161)}}
						case "sources":
							bad.Sources = make([]domain.CollectionSource, 17)
						}
						put("collections", "collection", bad)
						check(false, true)
						put("collections", "collection", c)
						check(true, false)
					}
				}
			})
		}
	}
}
