package httpapi_test

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

// Exercise the dashboard's public read, not a separate scheduling simulation.
func TestActionsReserveBoundedChecksForEligibleDrafts(t *testing.T) {
	for _, mode := range []string{"unsupported", "failed-preflight", "eligible", "scan-limit", "read-budget"} {
		t.Run(mode, func(t *testing.T) {
			s, srv := makeServer(t)
			owner := inviteClient(t, s, srv, "action-scheduling")
			count := 9
			if mode == "scan-limit" {
				count = 33
			}
			for i := 0; i < count; i++ {
				id := fmt.Sprintf("output-%02d", i)
				p := templateTestProfile("profile-"+id, render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
				code, _, raw := req(t, owner.c, "POST", srv.URL+"/api/me/profiles", owner.csrf, p)
				if code != 200 {
					t.Fatal(raw)
				}
				code, _, raw = req(t, owner.c, "POST", srv.URL+"/api/me/outputs", owner.csrf, map[string]any{"id": id, "name": id, "profileId": p.ID, "target": p.Target})
				if code != 201 {
					t.Fatal(raw)
				}
				p.IR.Endpoints[0].Connection.Password = "changed-password"
				if mode == "read-budget" {
					p.Name = strings.Repeat("x", 300<<10)
				}
				if i < count-1 {
					switch mode {
					case "unsupported", "scan-limit", "read-budget":
						p.PlatformEntryIDs = []string{"platform-entry"}
					case "failed-preflight":
						p.CollectionID = "missing-collection"
					}
				}
				if err := s.TenantPut(owner.id, "profiles", p.ID, p); err != nil {
					t.Fatal(err)
				}
			}
			var before httpapi.Output
			if err := s.TenantGet(owner.id, "outputs", "output-08", &before); err != nil {
				t.Fatal(err)
			}
			code, v, raw := req(t, owner.c, "GET", srv.URL+"/api/me/actions", "", nil)
			if code != 200 || v["partial"] != true {
				t.Fatalf("actions: %d %s", code, raw)
			}
			items := v["items"].([]any)
			unchecked := v["uncheckedOutputs"].([]any)
			switch mode {
			case "unsupported":
				if len(items) != 1 || items[0].(map[string]any)["id"] != "output:output-08" || items[0].(map[string]any)["kind"] != "output-changed" || len(unchecked) != 8 {
					t.Fatal(raw)
				}
			case "scan-limit":
				if len(items) != 0 || len(unchecked) != 32 || v["platformRoutesComplete"] != false {
					t.Fatal(raw)
				}
			case "read-budget":
				if len(items) != 0 || len(unchecked) != 9 {
					t.Fatal(raw)
				}
			case "failed-preflight":
				// Failed preflights still consume the expensive-work allowance.
				if len(items) != 0 || len(unchecked) != 9 {
					t.Fatal(raw)
				}
			case "eligible":
				if len(items) != 8 || len(unchecked) != 1 || unchecked[0].(map[string]any)["id"] != "output-08" {
					t.Fatal(raw)
				}
			}
			// Dashboard reads must not publish any draft or rewrite its revision.
			var output httpapi.Output
			if err := s.TenantGet(owner.id, "outputs", "output-08", &output); err != nil || !reflect.DeepEqual(output, before) {
				t.Fatalf("publication changed: %v", err)
			}
		})
	}
}
