package httpapi_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

func advancedSummaryProfile() httpapi.Profile {
	p := templateTestProfile("advanced-summary", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.IR.Groups = []domain.PolicyGroup{{ID: "default-group", Name: "Default,choice", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "node"}, {Kind: "direct"}}}}
	p.IR.DefaultAction = domain.ActionRef{Kind: "group", Ref: "default-group"}
	p.IR.Rules = []domain.PolicyRule{{ID: "reject-example", Match: domain.MatchExpression{Op: "domain", Value: "private-rule.example"}, Action: domain.ActionRef{Kind: "reject"}}}
	return p
}

func advancedDetails(t *testing.T, response map[string]any) map[string]any {
	t.Helper()
	summary, ok := response["routingSummary"].(map[string]any)
	if !ok || summary["kind"] != "advanced" {
		t.Fatalf("missing advanced summary: %#v", response["routingSummary"])
	}
	details, ok := summary["advanced"].(map[string]any)
	if !ok {
		t.Fatalf("missing frozen advanced details: %#v", summary)
	}
	return details
}

func TestPublishedRoutingSummaryAdvancedDefaultActions(t *testing.T) {
	for _, action := range []domain.ActionRef{{Kind: "group", Ref: "default-group"}, {Kind: "endpoint", Ref: "node"}, {Kind: "direct"}, {Kind: "reject"}} {
		t.Run(action.Kind, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "advanced-actions")
			p := advancedSummaryProfile()
			p.IR.DefaultAction = action
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "advanced", "name": "Advanced", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			details := advancedDetails(t, out)
			if details["ruleCount"] != float64(1) || details["groupCount"] != float64(1) || details["nodeCount"] != float64(1) {
				t.Fatalf("unexpected structural counts: %#v", details)
			}
			got := details["defaultAction"].(map[string]any)
			if got["kind"] != action.Kind {
				t.Fatalf("wrong default action: %#v", got)
			}
			switch action.Kind {
			case "group":
				if got["label"] != "Default，choice" {
					t.Fatalf("group must use allocated name, not selected endpoint: %#v", got)
				}
			case "endpoint":
				if got["label"] != "Private node" {
					t.Fatal(got)
				}
			default:
				if got["label"] != nil {
					t.Fatal("built-in action invented endpoint label")
				}
			}
			summaryJSON, _ := json.Marshal(out["routingSummary"])
			for _, secret := range []string{"private-rule.example", "secret-password", "private-user", "192.0.2.9", "members", "endpointId", "testURL"} {
				if strings.Contains(string(summaryJSON), secret) {
					t.Fatalf("summary leaked non-allowlisted data %s", secret)
				}
			}
		})
	}
}

func TestPublishedRoutingSummaryAdvancedPublicationIsIndependent(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "advanced-freeze")
	p := advancedSummaryProfile()
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	for _, id := range []string{"first", "second"} {
		code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": id, "name": id, "profileId": p.ID})
		if code != 201 {
			t.Fatal(raw)
		}
	}
	var firstBefore, secondBefore httpapi.Output
	if err := s.TenantGet(u.id, "outputs", "first", &firstBefore); err != nil {
		t.Fatal(err)
	}
	if err := s.TenantGet(u.id, "outputs", "second", &secondBefore); err != nil {
		t.Fatal(err)
	}
	p.IR.Groups[0].Name = "New default choice"
	p.IR.DefaultAction = domain.ActionRef{Kind: "direct"}
	p.IR.Rules = nil
	code, _, raw = putCurrentProfileDraft(t, u, srv.URL+"/api/me/profiles/"+p.ID, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, status, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/first/status", "", nil)
	if code != 200 || status["draftComparison"].(map[string]any)["state"] != "changed" {
		t.Fatal(raw)
	}
	if advancedDetails(t, status)["defaultAction"].(map[string]any)["label"] != "Default，choice" {
		t.Fatal("profile save rewrote publication")
	}
	code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "first"})
	if code != 200 {
		t.Fatal(raw)
	}
	if advancedDetails(t, review)["defaultAction"].(map[string]any)["kind"] != "direct" {
		t.Fatal("candidate did not reflect accepted draft")
	}
	if review["publishedRoutingSummary"].(map[string]any)["advanced"].(map[string]any)["defaultAction"].(map[string]any)["kind"] != "group" {
		t.Fatal("review lost frozen publication")
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs/first/publish", u.csrf, map[string]any{"previewDigest": review["previewDigest"]})
	if code != 200 {
		t.Fatal(raw)
	}
	var firstAfter, secondAfter httpapi.Output
	if err := s.TenantGet(u.id, "outputs", "first", &firstAfter); err != nil {
		t.Fatal(err)
	}
	if err := s.TenantGet(u.id, "outputs", "second", &secondAfter); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(secondBefore, secondAfter) {
		t.Fatal("publishing first altered second output")
	}
	if firstBefore.ID != firstAfter.ID || firstBefore.Token != firstAfter.Token || firstBefore.TokenDigest != firstAfter.TokenDigest {
		t.Fatal("summary update changed output identity or access")
	}
	if reflect.DeepEqual(firstBefore.RoutingSummary, firstAfter.RoutingSummary) || reflect.DeepEqual(firstBefore.Artifacts, firstAfter.Artifacts) {
		t.Fatal("reviewed publication did not update summary and artifact together")
	}
	code, status, raw = req(t, u.c, "GET", srv.URL+"/api/me/outputs/second/status", "", nil)
	if code != 200 || advancedDetails(t, status)["defaultAction"].(map[string]any)["kind"] != "group" {
		t.Fatal(raw)
	}
}

func TestPublishedRoutingSummaryAdvancedUsesMaterializedSource(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "advanced-source")
	source := map[string]any{"id": "source", "applyMode": "manual", "name": "Source", "kind": "text", "content": "socks5://one.example:1080#One\nsocks5://two.example:1080#Two", "enabled": true}
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/sources", u.csrf, source)
	if code != 200 {
		t.Fatal(raw)
	}
	p := templateTestProfile("materialized", render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion})
	p.SourceIDs = []string{"source"}
	// The raw draft has one endpoint; the accepted source has two. Neither the
	// summary nor the renderer should use the raw draft's stale node count.
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "materialized", "name": "Materialized", "profileId": p.ID})
	if code != 201 || advancedDetails(t, out)["nodeCount"] != float64(2) {
		t.Fatal(raw)
	}
	source["content"] = "socks5://one.example:1080#Renamed"
	code, pending, raw := req(t, u.c, "PUT", srv.URL+"/api/me/sources/source", u.csrf, source)
	if code != 200 {
		t.Fatal(raw)
	}
	// A manual source update is not active input until explicitly
	// applied. Both the Output candidate and publication still use two nodes.
	code, beforeAcceptance, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "materialized"})
	if code != 200 || advancedDetails(t, beforeAcceptance)["nodeCount"] != float64(2) {
		t.Fatal(raw)
	}
	sourceCandidate := pending["candidate"].(map[string]any)
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/sources/source/candidate/accept", u.csrf, map[string]any{"candidateId": sourceCandidate["id"], "sourceRevision": pending["revision"]})
	if code != 200 {
		t.Fatal(raw)
	}
	code, review, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "materialized"})
	if code != 200 || advancedDetails(t, review)["nodeCount"] != float64(1) {
		t.Fatal(raw)
	}
	if review["publishedRoutingSummary"].(map[string]any)["advanced"].(map[string]any)["nodeCount"] != float64(2) {
		t.Fatal("source refresh changed frozen count")
	}
	code, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/outputs", "", nil)
	if code != 200 || !strings.Contains(raw, `"nodeCount":2`) {
		t.Fatal(raw)
	}
}

func TestPublishedRoutingSummaryAdvancedLegacyDetailsDoNotInventPendingChanges(t *testing.T) {
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "advanced-legacy")
	p := advancedSummaryProfile()
	code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "legacy", "name": "Legacy", "profileId": p.ID})
	if code != 201 {
		t.Fatal(raw)
	}
	var legacy httpapi.Output
	if err := s.TenantGet(u.id, "outputs", "legacy", &legacy); err != nil {
		t.Fatal(err)
	}
	legacy.RoutingSummary = &httpapi.RoutingSummary{Version: 1, Kind: "advanced"}
	if err := s.TenantPut(u.id, "outputs", "legacy", legacy); err != nil {
		t.Fatal(err)
	}
	code, status, raw := req(t, u.c, "GET", srv.URL+"/api/me/outputs/legacy/status", "", nil)
	if code != 200 || status["routingSummary"].(map[string]any)["advanced"] != nil || status["draftComparison"].(map[string]any)["state"] != "unchanged" {
		t.Fatal(raw)
	}
	p.IR.DefaultAction = domain.ActionRef{Kind: "reject"}
	code, _, raw = putCurrentProfileDraft(t, u, srv.URL+"/api/me/profiles/"+p.ID, p)
	if code != 200 {
		t.Fatal(raw)
	}
	code, status, raw = req(t, u.c, "GET", srv.URL+"/api/me/outputs/legacy/status", "", nil)
	if code != 200 || status["routingSummary"].(map[string]any)["advanced"] != nil || status["draftComparison"].(map[string]any)["state"] != "changed" {
		t.Fatal(raw)
	}
	var after httpapi.Output
	if err := s.TenantGet(u.id, "outputs", "legacy", &after); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(legacy, after) {
		t.Fatal("status backfilled old summary from current profile")
	}
}

func TestPublishedRoutingSummaryAdvancedRedactsGroupLabels(t *testing.T) {
	for _, label := range []string{" secret,password ", "https://private.example/feed/token", "prefix secret,password suffix"} {
		t.Run(label, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "advanced-safe-labels")
			p := advancedSummaryProfile()
			p.IR.Endpoints[0].Connection.Password = " secret,password "
			p.IR.Groups[0].Name = label
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "safe", "name": "Safe", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			for _, path := range []string{"/api/me/outputs", "/api/me/outputs/safe/status"} {
				code, _, raw = req(t, u.c, "GET", srv.URL+path, "", nil)
				if code != 200 {
					t.Fatal(raw)
				}
				for _, secret := range []string{"secret,password", "secret，password", "private.example", "/feed/token", "private-user"} {
					if strings.Contains(raw, secret) {
						t.Fatalf("advanced metadata leaked %s", secret)
					}
				}
			}
		})
	}
}
