package httpapi_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func TestSemanticPublicationReviewExplainsFrozenGroupMembers(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "semantic-members")
	p := advancedSummaryProfile()
	other := p.IR.Endpoints[0]
	other.ID, other.Name = "other", "London"
	p.IR.Endpoints = append(p.IR.Endpoints, other)
	call := func(method, path string, body any, want int) map[string]any {
		t.Helper()
		code, value, raw := req(t, u.c, method, srv.URL+"/api/me"+path, u.csrf, body)
		if code != want {
			t.Fatalf("%s %s: %d %s", method, path, code, raw)
		}
		return value
	}
	call("POST", "/profiles", p, 200)
	for _, id := range []string{"chosen", "independent"} {
		call("POST", "/outputs", map[string]any{"id": id, "name": id, "profileId": p.ID}, 201)
	}
	p.IR.Groups[0].Members = []domain.ActionRef{{Kind: "endpoint", Ref: "other"}, {Kind: "direct"}}
	saveCurrentProfileDraft(t, u, srv.URL+"/api/me/profiles/"+p.ID, p)
	preview := call("POST", "/profiles/"+p.ID+"/preview", map[string]any{"outputId": "chosen"}, 200)
	semantic, ok := preview["semanticChanges"].(map[string]any)
	if !ok {
		t.Fatal("selected publication review must explain group and connection changes")
	}
	groups := semantic["groups"].(map[string]any)
	if groups["state"] != "available" || groups["changedCount"] != float64(1) {
		t.Fatalf("group changes: %#v", groups)
	}
	row := groups["rows"].([]any)[0].(map[string]any)
	if row["strategyChanged"] != false || row["memberOrderChanged"] != false {
		t.Fatalf("replacement is not a strategy/order change: %#v", row)
	}
	removed := row["membersRemoved"].([]any)[0].(map[string]any)
	added := row["membersAdded"].([]any)[0].(map[string]any)
	if removed["ref"] != "node" || added["ref"] != "other" || added["label"] != "London" {
		t.Fatalf("stable member identities lost: %#v", row)
	}
	if row["usesBefore"].(map[string]any)["default"] != true || row["usesAfter"].(map[string]any)["default"] != true {
		t.Fatal("default use should remain visible")
	}
	if semantic["nodes"].(map[string]any)["changedCount"] != float64(0) {
		t.Fatal("member replacement must not invent node setting changes")
	}
	call("POST", "/outputs/chosen/publish", map[string]any{"previewDigest": preview["previewDigest"]}, 200)
	updated := call("POST", "/profiles/"+p.ID+"/preview", map[string]any{"outputId": "chosen"}, 200)
	if updated["semanticChanges"].(map[string]any)["groups"].(map[string]any)["changedCount"] != float64(0) {
		t.Fatal("published comparison did not advance")
	}
	independent := call("POST", "/profiles/"+p.ID+"/preview", map[string]any{"outputId": "independent"}, 200)
	if independent["semanticChanges"].(map[string]any)["groups"].(map[string]any)["changedCount"] != float64(1) {
		t.Fatal("publishing chosen rewrote another publication baseline")
	}
}

func semanticReviewHarness(t *testing.T, p httpapi.Profile) (func(string, string, any, int) map[string]any, func(func(*httpapi.Output)), func(httpapi.Profile)) {
	t.Helper()
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "semantic-test")
	call := func(method, path string, body any, want int) map[string]any {
		t.Helper()
		code, value, raw := req(t, u.c, method, srv.URL+"/api/me"+path, u.csrf, body)
		if code != want {
			t.Fatalf("%s %s: %d %s", method, path, code, raw)
		}
		return value
	}
	call("POST", "/profiles", p, 200)
	call("POST", "/outputs", map[string]any{"id": "main", "name": "Main", "profileId": p.ID}, 201)
	fixture := func(edit func(*httpapi.Output)) {
		t.Helper()
		var output httpapi.Output
		if err := s.TenantGet(u.id, "outputs", "main", &output); err != nil {
			t.Fatal(err)
		}
		edit(&output)
		if err := s.TenantPut(u.id, "outputs", "main", output); err != nil {
			t.Fatal(err)
		}
	}
	save := func(profile httpapi.Profile) {
		t.Helper()
		saveCurrentProfileDraft(t, u, srv.URL+"/api/me/profiles/"+profile.ID, profile)
	}
	return call, fixture, save
}

func semanticCategory(t *testing.T, preview map[string]any, name string) map[string]any {
	t.Helper()
	semantic, ok := preview["semanticChanges"].(map[string]any)
	if !ok {
		t.Fatal("missing semantic review")
	}
	category, ok := semantic[name].(map[string]any)
	if !ok {
		t.Fatalf("missing semantic category %s", name)
	}
	return category
}

func TestSemanticPublicationReviewConnectionCategoriesRedactBothVersions(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			p := advancedSummaryProfile()
			p.Target = target
			call, _, save := semanticReviewHarness(t, p)
			p.IR.Endpoints[0].Connection.Password = "rotated-sensitive"
			p.IR.Endpoints[0].Connection.Port++
			p.IR.Endpoints[0].Name = "Old secret-password and rotated-sensitive"
			p.IR.Groups[0].Name = "Group secret-password rotated-sensitive"
			save(p)
			preview := call("POST", "/profiles/"+p.ID+"/preview", map[string]any{"outputId": "main"}, 200)
			nodes := semanticCategory(t, preview, "nodes")
			if nodes["state"] != "available" || nodes["changedCount"] != float64(1) {
				t.Fatalf("connection coverage: %#v", nodes)
			}
			row := nodes["rows"].([]any)[0].(map[string]any)
			if row["settingsChanged"] != true || row["nameChanged"] != true || !reflect.DeepEqual(row["changedCategories"], []any{"endpoint", "authentication"}) {
				t.Fatalf("connection classification: %#v", row)
			}
			if len(row["usesAfter"].(map[string]any)["groups"].([]any)) != 1 {
				t.Fatal("connection should name its direct policy-group use")
			}
			raw, _ := json.Marshal(preview["semanticChanges"])
			for _, forbidden := range []string{"secret-password", "rotated-sensitive", "private-user", "192.0.2.9", "Digest", "Fingerprint", "categoryDigests", "semanticSnapshot"} {
				if strings.Contains(string(raw), forbidden) {
					t.Fatalf("semantic review leaked protected material %q", forbidden)
				}
			}
		})
	}
}

func TestSemanticPublicationReviewDoesNotRedefineDeliveredEquality(t *testing.T) {
	for _, scenario := range []string{"legacy", "identity-only", "normalized-settings", "dynamic-recipe"} {
		t.Run(scenario, func(t *testing.T) {
			p := advancedSummaryProfile()
			p.Target = render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
			if scenario == "normalized-settings" {
				p.IR.Endpoints[0].Connection = domain.Connection{Protocol: "vless", Host: "node.example", Port: 443, UUID: "00000000-0000-4000-8000-000000000001", TLS: &domain.TLSOptions{Enabled: true, Fingerprint: "chrome"}}
			}
			if scenario == "dynamic-recipe" {
				p.IR.Groups[0].Members = nil
				p.IR.Groups[0].Dynamic = &domain.EndpointFilter{}
			}
			call, fixture, save := semanticReviewHarness(t, p)
			switch scenario {
			case "legacy":
				fixture(func(o *httpapi.Output) { o.SemanticSnapshot = nil })
			case "identity-only":
				p.IR.Endpoints[0].ID = "replacement"
				p.IR.Groups[0].Members[0].Ref = "replacement"
			case "normalized-settings":
				p.IR.Endpoints[0].Connection.TLS.Fingerprint = "Chrome"
				p.IR.Endpoints[0].Connection.Transport = &domain.TransportOptions{Type: "tcp"}
			case "dynamic-recipe":
				p.IR.Groups[0].Dynamic.NamePattern = "Private"
			}
			save(p)
			status := call("GET", "/outputs/main/status", nil, 200)
			if status["draftComparison"].(map[string]any)["state"] != "unchanged" {
				t.Fatalf("metadata/identity edit invented pending delivery change: %#v", status["draftComparison"])
			}
			preview := call("POST", "/profiles/"+p.ID+"/preview", map[string]any{"outputId": "main"}, 200)
			if preview["semanticChanges"].(map[string]any)["renderedConfigurationChanged"] != false {
				t.Fatal("byte-equivalent output was called changed")
			}
			groups := semanticCategory(t, preview, "groups")
			if scenario == "legacy" {
				if groups["state"] != "unavailable" || groups["reason"] != "baseline-missing" || groups["changedCount"] != nil {
					t.Fatalf("legacy baseline invented: %#v", groups)
				}
				fixture(func(o *httpapi.Output) {
					if o.SemanticSnapshot != nil {
						t.Fatal("preview backfilled historical metadata")
					}
				})
			} else if scenario == "identity-only" {
				if groups["changedCount"] != float64(1) || semanticCategory(t, preview, "nodes")["changedCount"] != float64(2) {
					t.Fatal("stable source identities were lost merely because bytes match")
				}
			} else if groups["changedCount"] != float64(0) || semanticCategory(t, preview, "nodes")["changedCount"] != float64(0) {
				t.Fatal("unemitted/normalized settings invented semantic edits")
			}
		})
	}
}

func TestSemanticPublicationReviewCoverageIsExplicitAndPublicationStillWorks(t *testing.T) {
	for _, scenario := range []string{"native", "unknown-version", "missing-inventory", "unknown-member", "mismatched-label", "missing-setting-category", "group-limit", "node-limit", "malformed-artifact"} {
		t.Run(scenario, func(t *testing.T) {
			p := advancedSummaryProfile()
			if scenario == "native" {
				p = nativeProfile(p.Target, `{"tcp-concurrent":true}`)
			}
			if scenario == "node-limit" {
				seed := p.IR.Endpoints[0]
				for i := 0; i < 150; i++ {
					n := seed
					n.ID = fmt.Sprintf("extra-%d", i)
					n.Name = fmt.Sprintf("Node %d", i)
					p.IR.Endpoints = append(p.IR.Endpoints, n)
				}
			}
			call, fixture, _ := semanticReviewHarness(t, p)
			switch scenario {
			case "unknown-version":
				fixture(func(o *httpapi.Output) { o.SemanticSnapshot.Version = 999 })
			case "missing-inventory":
				fixture(func(o *httpapi.Output) { o.SemanticSnapshot.Groups.Items = nil; o.SemanticSnapshot.Nodes.Items = nil })
			case "unknown-member":
				fixture(func(o *httpapi.Output) { o.SemanticSnapshot.Groups.Items[0].Members[0].Ref = "never-published" })
			case "mismatched-label":
				fixture(func(o *httpapi.Output) { o.SemanticSnapshot.Nodes.Items[0].Label = "Not the emitted name" })
			case "missing-setting-category":
				fixture(func(o *httpapi.Output) { delete(o.SemanticSnapshot.Nodes.Items[0].CategoryDigests, "authentication") })
			case "group-limit":
				fixture(func(o *httpapi.Output) {
					o.SemanticSnapshot.Groups = render.SemanticGroupSnapshot{State: "unavailable", Reason: "size-limit"}
				})
			case "malformed-artifact":
				fixture(func(o *httpapi.Output) { o.Artifacts[0].Content = `{"proxies":[]}` })
			}
			preview := call("POST", "/profiles/"+p.ID+"/preview", map[string]any{"outputId": "main"}, 200)
			name, reason := "groups", "unsupported"
			switch scenario {
			case "unknown-version", "missing-inventory", "unknown-member", "mismatched-label", "missing-setting-category":
				reason = "invalid-snapshot"
			case "group-limit":
				reason = "size-limit"
			case "node-limit":
				name = "nodes"
				reason = "size-limit"
			case "malformed-artifact":
				reason = "redaction-unavailable"
			}
			category := semanticCategory(t, preview, name)
			if category["state"] != "unavailable" || category["reason"] != reason || category["beforeCount"] != nil {
				t.Fatalf("wrong coverage: %#v", category)
			}
			if scenario == "node-limit" && semanticCategory(t, preview, "groups")["state"] != "available" {
				t.Fatal("node budget need not discard group coverage")
			}
			call("POST", "/outputs/main/publish", map[string]any{"previewDigest": preview["previewDigest"]}, 200)
		})
	}
}

func TestSemanticPublicationReviewBoundsChangesAndDirectUses(t *testing.T) {
	p := advancedSummaryProfile()
	p.IR.Groups = nil
	for i := 0; i < 60; i++ {
		p.IR.Groups = append(p.IR.Groups, domain.PolicyGroup{ID: fmt.Sprintf("group-%d", i), Name: fmt.Sprintf("Group %d", i), Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "node"}}})
	}
	p.IR.DefaultAction = domain.ActionRef{Kind: "group", Ref: "group-0"}
	p.IR.Rules = nil
	for i := 0; i < 12; i++ {
		p.IR.Rules = append(p.IR.Rules, domain.PolicyRule{ID: fmt.Sprintf("rule-%d", i), Match: domain.MatchExpression{Op: "domain", Value: fmt.Sprintf("site%d.example", i)}, Action: domain.ActionRef{Kind: "endpoint", Ref: "node"}})
	}
	call, _, save := semanticReviewHarness(t, p)
	for i := range p.IR.Groups {
		p.IR.Groups[i].Kind = "url-test"
		p.IR.Groups[i].TestURL = "https://probe.example/check"
		p.IR.Groups[i].IntervalSeconds = 300
	}
	p.IR.Endpoints[0].Connection.Port++
	save(p)
	preview := call("POST", "/profiles/"+p.ID+"/preview", map[string]any{"outputId": "main"}, 200)
	groups := semanticCategory(t, preview, "groups")
	if groups["changedCount"] != float64(60) || groups["omittedRowCount"] != float64(10) || len(groups["rows"].([]any)) != 50 {
		t.Fatalf("group row budget: %#v", groups)
	}
	first := groups["rows"].([]any)[0].(map[string]any)
	if first["strategyChanged"] != true || first["before"].(map[string]any)["selection"] != "manual" || first["after"].(map[string]any)["selection"] != "url-test" {
		t.Fatal("strategy change needs before/after meaning")
	}
	node := semanticCategory(t, preview, "nodes")["rows"].([]any)[0].(map[string]any)
	uses := node["usesAfter"].(map[string]any)
	if uses["scope"] != "direct" || uses["state"] != "partial" || uses["default"] != false || uses["omittedGroupCount"] != float64(50) || uses["omittedRuleCount"] != float64(2) {
		t.Fatalf("direct usages and bounds: %#v", uses)
	}
	if uses["rules"].([]any)[0].(map[string]any)["index"] != float64(1) {
		t.Fatal("rule order is 1-based frozen position")
	}
}

func TestSemanticPublicationReviewRemainsOwnerSelectedOnly(t *testing.T) {
	p := advancedSummaryProfile()
	call, _, _ := semanticReviewHarness(t, p)
	for _, path := range []string{"/outputs/main/status", "/outputs/main/access", "/outputs/main/comparison"} {
		view := call("GET", path, nil, 200)
		for _, key := range []string{"semanticChanges", "semanticSnapshot", "categoryDigests", "parametersDigest"} {
			if view[key] != nil {
				t.Fatalf("private semantic data escaped %s", path)
			}
		}
	}
	for _, body := range []any{map[string]any{}, map[string]any{"target": p.Target}} {
		view := call("POST", "/profiles/"+p.ID+"/preview", body, 200)
		if view["semanticChanges"] != nil || view["semanticSnapshot"] != nil {
			t.Fatal("draft preview is not a frozen publication comparison")
		}
	}
	newOutput := call("POST", "/outputs/preview", map[string]any{"id": "new", "name": "New", "profileId": p.ID}, 200)
	if newOutput["semanticChanges"] != nil || newOutput["semanticSnapshot"] != nil {
		t.Fatal("creation review invented a publication baseline")
	}
}

func TestSemanticPublicationReviewMemberIdentityOrderAndPartialUses(t *testing.T) {
	p := advancedSummaryProfile()
	seed := p.IR.Endpoints[0]
	for i := 0; i < 35; i++ {
		node := seed
		node.ID = fmt.Sprintf("member-%d", i)
		node.Name = fmt.Sprintf("Member %d", i)
		p.IR.Endpoints = append(p.IR.Endpoints, node)
	}
	p.IR.Groups[0].Members = []domain.ActionRef{{Kind: "endpoint", Ref: "node"}, {Kind: "endpoint", Ref: "member-0"}}
	p.IR.Rules = []domain.PolicyRule{{ID: "group-rule", Match: domain.MatchExpression{Op: "domain", Value: "work.example"}, Action: domain.ActionRef{Kind: "group", Ref: "default-group"}}}
	call, fixture, save := semanticReviewHarness(t, p)
	// This models a previously bounded, truthful publication rather than
	// reconstructing the absent rule from today's mutable profile.
	fixture(func(o *httpapi.Output) { o.RoutingIntent.Rules = nil; o.RoutingIntent.OmittedRuleCount = 1 })
	p.IR.Groups[0].Members = []domain.ActionRef{{Kind: "endpoint", Ref: "member-0"}, {Kind: "endpoint", Ref: "node"}}
	for i := 1; i < 35; i++ {
		p.IR.Groups[0].Members = append(p.IR.Groups[0].Members, domain.ActionRef{Kind: "endpoint", Ref: fmt.Sprintf("member-%d", i)})
	}
	save(p)
	preview := call("POST", "/profiles/"+p.ID+"/preview", map[string]any{"outputId": "main"}, 200)
	row := semanticCategory(t, preview, "groups")["rows"].([]any)[0].(map[string]any)
	if row["memberOrderChanged"] != true || len(row["membersAdded"].([]any)) != 20 || row["omittedAddedMemberCount"] != float64(14) {
		t.Fatalf("member order/detail budget: %#v", row)
	}
	before, after := row["usesBefore"].(map[string]any), row["usesAfter"].(map[string]any)
	if before["state"] != "partial" || len(before["rules"].([]any)) != 0 || after["state"] != "available" || after["rules"].([]any)[0].(map[string]any)["id"] != "group-rule" {
		t.Fatal("missing historical usage was backfilled or called unused")
	}
}

func TestSemanticPublicationReviewCannotExposeAnotherOwner(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "semantic-owner")
	other := inviteClient(t, s, srv, "semantic-other")
	p := advancedSummaryProfile()
	if code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p); code != 200 {
		t.Fatal(raw)
	}
	if code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "owned", "name": "Owned", "profileId": p.ID}); code != 201 {
		t.Fatal(raw)
	}
	_, _, list := req(t, u.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	for _, key := range []string{"semanticSnapshot", "settingsDigest", "categoryDigests", "semanticChanges"} {
		if strings.Contains(list, key) {
			t.Fatalf("list leaked %s", key)
		}
	}
	otherProfile := advancedSummaryProfile()
	otherProfile.ID = "other-profile"
	if code, _, raw := req(t, other.c, "POST", srv.URL+"/api/me/profiles", other.csrf, otherProfile); code != 200 {
		t.Fatal(raw)
	}
	code, _, raw := req(t, other.c, "POST", srv.URL+"/api/me/profiles/other-profile/preview", other.csrf, map[string]any{"outputId": "owned"})
	if code != 404 || strings.Contains(raw, "semanticChanges") || strings.Contains(raw, "semanticSnapshot") {
		t.Fatalf("cross-owner semantic review: %d %s", code, raw)
	}
}
