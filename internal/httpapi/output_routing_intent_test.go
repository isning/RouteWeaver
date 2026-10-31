package httpapi_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func privateIntentProfile() httpapi.Profile {
	p := templateTestProfile("private-intent", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.IR.Endpoints = []domain.ClientEndpoint{
		{ID: "hong-kong", Name: "香港-日常", OwnerID: p.IR.OwnerID, Origin: "imported", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.10", Port: 1080}},
		{ID: "tokyo", Name: "东京-ChatGPT", OwnerID: p.IR.OwnerID, Origin: "imported", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.20", Port: 1080}},
		{ID: "london", Name: "伦敦-备用", OwnerID: p.IR.OwnerID, Origin: "imported", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.30", Port: 1080}},
	}
	p.IR.Groups = nil
	p.IR.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "hong-kong"}
	p.IR.Rules = []domain.PolicyRule{{ID: "chatgpt-domain", Match: domain.MatchExpression{Op: "domain-suffix", Value: "chatgpt.com"}, Action: domain.ActionRef{Kind: "endpoint", Ref: "tokyo"}}}
	return p
}

func TestPrivateFrozenRoutingIntentKeepsOmittedMatchesAndOpaqueModesHonest(t *testing.T) {
	for _, scenario := range []string{"sensitive-match", "native-override", "nodes-only"} {
		t.Run(scenario, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "private-intent-coverage")
			p := privateIntentProfile()
			switch scenario {
			case "sensitive-match":
				p.IR.Endpoints[0].Connection.Username = "private-user"
				p.IR.Endpoints[0].Connection.Password = "chatgpt.com"
				p.IR.Endpoints[1].Name = "prefix chatgpt.com suffix"
			case "native-override":
				p.IR.NativeOverride = &domain.NativeClientOverride{SchemaVersion: "1", Namespace: "routeweaver/native-client", Target: domain.NativeClientTarget{AdapterID: p.Target.AdapterID, Version: p.Target.Version}, Format: "json", RuleMode: "prepend", Content: `{"rules":["DOMAIN-SUFFIX,private-native.example,DIRECT"]}`}
			case "nodes-only":
				p.Mode = render.NodesOnly
			}
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			creation := map[string]any{"id": "device", "name": "Device", "profileId": p.ID}
			code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, creation)
			if code != 200 {
				t.Fatal(raw)
			}
			intent := ownerRoutingIntent(t, review, "routingIntent")
			if scenario == "sensitive-match" {
				rule := intent["rules"].([]any)[0].(map[string]any)
				match := rule["match"].(map[string]any)
				if match["state"] != "omitted" || match["reason"] != "sensitive" || match["expression"] != nil {
					t.Fatal("a credential-bearing match must be omitted, never altered and called exact")
				}
				encoded, _ := json.Marshal(intent)
				for _, secret := range []string{"chatgpt.com", "private-user", "192.0.2.10", "connection", "password", "provenance"} {
					if strings.Contains(string(encoded), secret) {
						t.Fatalf("private routing projection leaked non-policy data %q", secret)
					}
				}
			} else if !reflect.DeepEqual(intent, map[string]any{"version": float64(1), "kind": scenario}) {
				t.Fatalf("opaque/no-policy mode invented portable policy or zero-count certainty: %#v", intent)
			}
		})
	}
}

func TestPrivateFrozenRoutingIntentDetectsSameLabelStableReferenceChange(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "private-intent-identity")
	p := privateIntentProfile()
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "device", "name": "Device", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	// Replacing an endpoint identity can retain the same name and connection
	// bytes. It is still a different declared destination, not a rename.
	p.IR.Endpoints[1].ID = "tokyo-replacement"
	p.IR.Rules[0].Action.Ref = "tokyo-replacement"
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, status, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/device/status", "", nil)
	if code != 200 || status["draftComparison"].(map[string]any)["state"] != "changed" {
		t.Fatal("same displayed names hid a changed stable routing destination")
	}
	code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "device"})
	if code != 200 {
		t.Fatal(raw)
	}
	published := ownerRoutingIntent(t, review, "publishedRoutingIntent")["rules"].([]any)[0].(map[string]any)["action"].(map[string]any)
	candidate := ownerRoutingIntent(t, review, "routingIntent")["rules"].([]any)[0].(map[string]any)["action"].(map[string]any)
	if published["label"] != candidate["label"] || published["ref"] != "tokyo" || candidate["ref"] != "tokyo-replacement" {
		t.Fatal("owner review must preserve stable identity independently of the frozen label")
	}
}

func TestPrivateFrozenRoutingIntentBoundsOnlyTheSummaryNotRenderedPolicy(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "private-intent-budget")
	p := privateIntentProfile()
	children := []domain.MatchExpression{}
	for i := 0; i < 300; i++ {
		children = append(children, domain.MatchExpression{Op: "domain", Value: fmt.Sprintf("nested-%d.example", i)})
	}
	p.IR.Rules = []domain.PolicyRule{{ID: "large-match", Match: domain.MatchExpression{Op: "or", Children: children}, Action: domain.ActionRef{Kind: "endpoint", Ref: "tokyo"}}}
	for i := 0; i < 600; i++ {
		p.IR.Rules = append(p.IR.Rules, domain.PolicyRule{ID: fmt.Sprintf("rule-%d", i), Match: domain.MatchExpression{Op: "domain-suffix", Value: fmt.Sprintf("%05d.%s.example", i, strings.Repeat("a", 60))}, Action: domain.ActionRef{Kind: "endpoint", Ref: "tokyo"}})
	}
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, map[string]any{"id": "device", "name": "Device", "profileId": p.ID})
	if code != 200 {
		t.Fatal(raw)
	}
	intent := ownerRoutingIntent(t, review, "routingIntent")
	encoded, _ := json.Marshal(intent)
	rules := intent["rules"].([]any)
	if len(encoded) > 64<<10 || intent["ruleCount"] != float64(601) || intent["omittedRuleCount"].(float64) <= 0 || int(intent["omittedRuleCount"].(float64))+len(rules) != 601 {
		t.Fatal("large summary must preserve explicit rule coverage within its bounded size")
	}
	match := rules[0].(map[string]any)["match"].(map[string]any)
	if match["state"] != "omitted" || match["reason"] != "size-limit" || match["expression"] != nil {
		t.Fatal("oversized predicate must not be silently truncated or represented as exact")
	}
	artifact := review["artifacts"].([]any)[0].(map[string]any)["content"].(string)
	if !strings.Contains(artifact, p.IR.Rules[len(p.IR.Rules)-1].Match.Value) || !strings.Contains(artifact, "nested-299.example") {
		t.Fatal("summary bounds altered or omitted the delivered routing policy")
	}
}

func TestPrivateFrozenRoutingIntentLegacyAbsenceIsNotBackfilledOrPendingChange(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "private-intent-legacy")
	p := privateIntentProfile()
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "legacy", "name": "Legacy", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	// Model an existing persisted v1 Output, then exercise only public reads and
	// reviews. No read path is allowed to manufacture its missing historical data.
	var legacy httpapi.Output
	if err := s.TenantGet(u.id, "outputs", "legacy", &legacy); err != nil {
		t.Fatal(err)
	}
	legacy.RoutingIntent = nil
	if err := s.TenantPut(u.id, "outputs", "legacy", legacy); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		code, status, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/legacy/status", "", nil)
		if code != 200 || status["routingIntent"] != nil || status["draftComparison"].(map[string]any)["state"] != "unchanged" {
			t.Fatal("snapshot enrichment changed or backfilled an unchanged legacy publication: " + raw)
		}
	}
	p.IR.Rules[0].Action.Ref = "london"
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "legacy"})
	if code != 200 || review["publishedRoutingIntent"] != nil || review["routingIntent"] == nil {
		t.Fatal("legacy update review invented historical rule detail: " + raw)
	}
	code, status, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/legacy/status", "", nil)
	if code != 200 || status["routingIntent"] != nil || status["draftComparison"].(map[string]any)["state"] != "changed" {
		t.Fatal("legacy lack of rule detail hid a changed artifact: " + raw)
	}
}

func TestPrivateFrozenRoutingIntentDetailEnrichmentIsNotAConfigurationChange(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "private-intent-partial")
	p := privateIntentProfile()
	p.IR.Rules = append(p.IR.Rules, domain.PolicyRule{ID: "other", Match: domain.MatchExpression{Op: "domain", Value: "other.example"}, Action: domain.ActionRef{Kind: "direct"}})
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "partial", "name": "Partial", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	// A previously bounded publication may have saved fewer display rows. Its
	// actual artifact is unchanged; missing display detail is not a policy edit.
	var partial httpapi.Output
	if err := s.TenantGet(u.id, "outputs", "partial", &partial); err != nil {
		t.Fatal(err)
	}
	partial.RoutingIntent.Rules = partial.RoutingIntent.Rules[:1]
	partial.RoutingIntent.OmittedRuleCount = 1
	if err := s.TenantPut(u.id, "outputs", "partial", partial); err != nil {
		t.Fatal(err)
	}
	code, status, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/partial/status", "", nil)
	if code != 200 || status["draftComparison"].(map[string]any)["state"] != "unchanged" {
		t.Fatal("larger current display coverage was mistaken for a changed configuration")
	}
	if ownerRoutingIntent(t, status, "routingIntent")["omittedRuleCount"] != float64(1) {
		t.Fatal("status silently backfilled the partial published snapshot")
	}
}

func TestPrivateFrozenRoutingIntentPreservesBooleanOrderAndOnlyResourceReferences(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "private-intent-resource")
	upload := map[string]any{"resource": map[string]any{"id": "work-rules", "name": "工作域名", "format": "mihomo-yaml", "behavior": "domain", "updatePolicy": "follow"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte("payload:\n  - '+.private-file-content.example'\n"))}
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/resources/import", u.csrf, upload)
	if code != 201 {
		t.Fatal(raw)
	}
	p := privateIntentProfile()
	p.IR.Resources = []domain.RuleResource{{ID: "work-rules"}}
	p.IR.Rules = []domain.PolicyRule{
		{ID: "work", Match: domain.MatchExpression{Op: "and", Children: []domain.MatchExpression{{Op: "resource", Value: "work-rules"}, {Op: "not", Children: []domain.MatchExpression{{Op: "domain", Value: "excluded.example"}}}}}, Action: domain.ActionRef{Kind: "endpoint", Ref: "tokyo"}},
		{ID: "fallback", Match: domain.MatchExpression{Op: "ip-cidr", Value: "192.0.2.0/24"}, Action: domain.ActionRef{Kind: "direct"}},
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, map[string]any{"id": "device", "name": "Device", "profileId": p.ID})
	if code != 200 {
		t.Fatal(raw)
	}
	intent := ownerRoutingIntent(t, review, "routingIntent")
	wantResources := []any{map[string]any{"id": "work-rules", "label": "工作域名"}}
	if !reflect.DeepEqual(intent["resources"], wantResources) {
		t.Fatal("resource reference must use frozen safe identity/label, not file data or locator")
	}
	rules := intent["rules"].([]any)
	expression := rules[0].(map[string]any)["match"].(map[string]any)["expression"]
	wantExpression := map[string]any{"op": "and", "children": []any{map[string]any{"op": "resource", "value": "work-rules"}, map[string]any{"op": "not", "children": []any{map[string]any{"op": "domain", "value": "excluded.example"}}}}}
	if rules[0].(map[string]any)["id"] != "work" || rules[1].(map[string]any)["id"] != "fallback" || !reflect.DeepEqual(expression, wantExpression) {
		t.Fatal("frozen projection changed first-match order or boolean predicate semantics")
	}
	encoded, _ := json.Marshal(intent)
	for _, forbidden := range []string{"private-file-content.example", "path", "url", "digest", "contentBase64", "ownerId"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("private intent expanded resource contents or metadata %q", forbidden)
		}
	}
}

func ownerRoutingIntent(t *testing.T, response map[string]any, field string) map[string]any {
	t.Helper()
	intent, ok := response[field].(map[string]any)
	if !ok {
		t.Fatalf("owner review/detail is missing frozen %s: %#v", field, response[field])
	}
	return intent
}

func TestPrivateFrozenRoutingIntentShowsGenericRuleAtOwnerReview(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "private-intent-review")
	p := privateIntentProfile()
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	request := map[string]any{"id": "macbook", "name": "小林的 MacBook", "profileId": p.ID}
	code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, request)
	if code != 200 {
		t.Fatal(raw)
	}
	intent := ownerRoutingIntent(t, review, "routingIntent")
	want := map[string]any{
		"version": float64(1), "kind": "portable", "ruleCount": float64(1), "omittedRuleCount": float64(0),
		"defaultAction": map[string]any{"kind": "endpoint", "ref": "hong-kong", "label": "香港-日常"},
		"rules":         []any{map[string]any{"id": "chatgpt-domain", "match": map[string]any{"state": "exact", "expression": map[string]any{"op": "domain-suffix", "value": "chatgpt.com"}}, "action": map[string]any{"kind": "endpoint", "ref": "tokyo", "label": "东京-ChatGPT"}}},
	}
	if !reflect.DeepEqual(intent, want) {
		t.Fatalf("review lost exact ordered rule intent:\ngot %#v\nwant %#v", intent, want)
	}
}

func TestPrivateFrozenRoutingIntentStaysPublishedAndUpdatesOnlyReviewedOutput(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "private-intent-frozen")
	p := privateIntentProfile()
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	for _, id := range []string{"macbook", "android"} {
		creation := map[string]any{"id": id, "name": id, "profileId": p.ID}
		code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/preview", u.csrf, creation)
		if code != 200 {
			t.Fatal(raw)
		}
		creation["previewDigest"] = review["previewDigest"]
		code, created, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, creation)
		if code != 201 || created["routingIntent"] != nil || strings.Contains(raw, "chatgpt.com") {
			t.Fatal("creation must publish without adding private rule details to its ordinary output DTO")
		}
	}
	code, before, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/macbook/status", "", nil)
	if code != 200 {
		t.Fatal(raw)
	}
	frozen := ownerRoutingIntent(t, before, "routingIntent")
	code, accessBefore, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/macbook/access", "", nil)
	if code != 200 || accessBefore["routingIntent"] != nil {
		t.Fatal(raw)
	}
	p.IR.Rules[0].Action.Ref = "london"
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, status, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/macbook/status", "", nil)
	if code != 200 || !reflect.DeepEqual(frozen, ownerRoutingIntent(t, status, "routingIntent")) || status["draftComparison"].(map[string]any)["state"] != "changed" {
		t.Fatal("saving a same-count retarget changed frozen intent or hid the changed configuration")
	}
	code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "macbook"})
	if code != 200 {
		t.Fatal(raw)
	}
	if !reflect.DeepEqual(frozen, ownerRoutingIntent(t, review, "publishedRoutingIntent")) {
		t.Fatal("update review replaced historical routing intent with the current draft")
	}
	candidate := ownerRoutingIntent(t, review, "routingIntent")
	rule := candidate["rules"].([]any)[0].(map[string]any)
	if candidate["ruleCount"] != frozen["ruleCount"] || rule["action"].(map[string]any)["ref"] != "london" || rule["action"].(map[string]any)["label"] != "伦敦-备用" {
		t.Fatal("same-count retarget lost its exact destination in owner review")
	}
	code, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	if code != 200 || strings.Contains(raw, "routingIntent") || strings.Contains(raw, "chatgpt.com") {
		t.Fatal("ordinary output listing gained private rule details")
	}
	p.IR.Rules[0].Action = domain.ActionRef{Kind: "direct"}
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, _ = req(t, u.c, "POST", srv.URL+"/api/me/outputs/macbook/publish", u.csrf, map[string]any{"previewDigest": review["previewDigest"]})
	if code != 409 {
		t.Fatalf("changed intent accepted stale publication review: %d", code)
	}
	p.IR.Rules[0].Action = domain.ActionRef{Kind: "endpoint", Ref: "london"}
	code, _, raw = req(t, u.c, "PUT", srv.URL+"/api/me/profiles/"+p.ID, u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, review, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "macbook"})
	if code != 200 {
		t.Fatal(raw)
	}
	code, published, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs/macbook/publish", u.csrf, map[string]any{"previewDigest": review["previewDigest"]})
	if code != 200 || published["routingIntent"] != nil {
		t.Fatal(raw)
	}
	code, after, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/macbook/status", "", nil)
	if code != 200 || !reflect.DeepEqual(ownerRoutingIntent(t, review, "routingIntent"), ownerRoutingIntent(t, after, "routingIntent")) {
		t.Fatal("published detail does not show the reviewed immutable rule intent")
	}
	code, android, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/android/status", "", nil)
	if code != 200 || !reflect.DeepEqual(frozen, ownerRoutingIntent(t, android, "routingIntent")) {
		t.Fatal("publishing MacBook rewrote Android's frozen rule intent")
	}
	code, accessAfter, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/macbook/access", "", nil)
	if code != 200 || !reflect.DeepEqual(accessBefore, accessAfter) {
		t.Fatal("private intent publication changed the existing access link")
	}
	other := inviteClient(t, s, srv, "private-intent-other")
	code, _, _ = req(t, other.c, "GET", srv.URL+"/api/me/outputs/macbook/status", "", nil)
	if code != 404 {
		t.Fatalf("foreign owner could read frozen rule intent: %d", code)
	}
}
