package render_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

func TestExplicitEndpointAndGroupRenamePreservesRenderedReferences(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			profile := clientProfile()
			// Start with a collision so prior allocations are genuinely in use.
			profile.Endpoints[0].Name = "Shared label"
			profile.Groups[0].Name = "Shared label"
			profile.Groups = append(profile.Groups, domain.PolicyGroup{ID: "outer", Name: "Outer choice", Kind: "manual", Members: []domain.ActionRef{{Kind: "group", Ref: "manual"}}})
			profile.Rules = append(profile.Rules, domain.PolicyRule{ID: "endpoint-rule", Match: domain.MatchExpression{Op: "domain", Value: "endpoint.example.org"}, Action: domain.ActionRef{Kind: "endpoint", Ref: "uk"}})
			profile.DefaultAction = domain.ActionRef{Kind: "group", Ref: "outer"}
			before, err := render.DefaultClients().Render(profile, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			beforeGroups, _ := json.Marshal(profile.Groups)
			beforeRules, _ := json.Marshal(profile.Rules)
			beforeDefault := profile.DefaultAction
			profile.NameAllocations = before.NameAllocations
			profile.Endpoints[0].Name = "New endpoint, London"
			profile.Groups[0].Name = "New group, route"
			if err := domain.ValidateClientProfile(profile); err != nil {
				t.Fatal(err)
			}
			// Labels are the only intended graph edit; identity references do not move.
			groups := append([]domain.PolicyGroup{}, profile.Groups...)
			groups[0].Name = "Shared label"
			restoredGroups, _ := json.Marshal(groups)
			rules, _ := json.Marshal(profile.Rules)
			if string(restoredGroups) != string(beforeGroups) || string(rules) != string(beforeRules) || profile.DefaultAction != beforeDefault {
				t.Fatal("rename changed stable-ID policy graph")
			}
			after, err := render.DefaultClients().Render(profile, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			wantEndpoint, wantGroup := "New endpoint, London", "New group, route"
			if target.AdapterID == "mihomo" {
				wantEndpoint, wantGroup = "New endpoint， London", "New group， route"
			}
			if after.Names["uk"] != wantEndpoint || after.Names["manual"] != wantGroup {
				t.Fatalf("explicit rename did not replace prior allocation: %#v", after.Names)
			}
			for _, id := range []string{"us", "outer"} {
				if after.Names[id] != before.Names[id] {
					t.Fatalf("rename disturbed unrelated allocation %s", id)
				}
			}
			if after.Names["uk"] == before.Names["uk"] || after.Names["manual"] == before.Names["manual"] {
				t.Fatal("old labels retained despite explicit rename")
			}
			var config map[string]any
			if err := json.Unmarshal([]byte(after.Artifacts[0].Content), &config); err != nil {
				t.Fatal(err)
			}
			if target.AdapterID == "mihomo" {
				endpoints := config["proxies"].([]any)
				if len(endpoints) != 2 || endpoints[0].(map[string]any)["name"] != wantEndpoint || endpoints[0].(map[string]any)["server"] != profile.Endpoints[0].Connection.Host {
					t.Fatal("renamed endpoint definition points at wrong connection")
				}
				groups := config["proxy-groups"].([]any)
				if len(groups) != 2 {
					t.Fatalf("group count changed: %d", len(groups))
				}
				inner, outer := groups[0].(map[string]any), groups[1].(map[string]any)
				if inner["name"] != wantGroup || !reflect.DeepEqual(inner["proxies"], []any{wantEndpoint, after.Names["us"]}) || outer["name"] != after.Names["outer"] || !reflect.DeepEqual(outer["proxies"], []any{wantGroup}) {
					t.Fatal("renamed endpoint/group membership references stale or wrong names")
				}
				wantRules := []any{"DOMAIN-SUFFIX,example.org," + wantGroup, "DOMAIN,endpoint.example.org," + wantEndpoint, "MATCH," + after.Names["outer"]}
				if !reflect.DeepEqual(config["rules"], wantRules) {
					t.Fatalf("renamed rule/default references: got %#v want %#v", config["rules"], wantRules)
				}
			} else {
				outbounds := config["outbounds"].([]any)
				named := map[string]map[string]any{}
				for _, raw := range outbounds {
					node := raw.(map[string]any)
					named[node["tag"].(string)] = node
				}
				if len(named) != 5 || named[wantEndpoint]["server"] != profile.Endpoints[0].Connection.Host {
					t.Fatal("renamed endpoint definition missing, duplicated or wrong connection")
				}
				if !reflect.DeepEqual(named[wantGroup]["outbounds"], []any{wantEndpoint, after.Names["us"]}) || !reflect.DeepEqual(named[after.Names["outer"]]["outbounds"], []any{wantGroup}) {
					t.Fatal("renamed nested membership references stale or wrong tags")
				}
				route := config["route"].(map[string]any)
				rules := route["rules"].([]any)
				if len(rules) != 2 || rules[0].(map[string]any)["outbound"] != wantGroup || rules[1].(map[string]any)["outbound"] != wantEndpoint || route["final"] != after.Names["outer"] {
					t.Fatal("renamed rule/final references stale or wrong tags")
				}
			}
			for _, id := range []string{"uk", "manual"} {
				quoted, _ := json.Marshal(before.Names[id])
				if strings.Contains(after.Artifacts[0].Content, string(quoted)) {
					t.Fatalf("old allocated label for %s remains in rendered artifact", id)
				}
			}
		})
	}
}
