package httpapi_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/reuse"
)

type templateReviewFixture struct {
	t       *testing.T
	srv     *httptest.Server
	user    sessionClient
	profile httpapi.Profile
}

func newTemplateReviewFixture(t *testing.T, p httpapi.Profile) templateReviewFixture {
	t.Helper()
	s, srv := makeServer(t)
	u := inviteClient(t, s, srv, "routing-contract")
	return templateReviewFixture{t, srv, u, p}
}
func (f templateReviewFixture) request(method, path string, body any, want int) (map[string]any, string) {
	f.t.Helper()
	code, value, raw := req(f.t, f.user.c, method, f.srv.URL+path, f.user.csrf, body)
	if code != want {
		f.t.Fatalf("%s %s: want %d got %d: %s", method, path, want, code, raw)
	}
	return value, raw
}
func (f templateReviewFixture) publish(version int, spec reuse.Spec) {
	f.t.Helper()
	code, _, raw := adminTemplateRequest(f.t, f.srv, profileTemplate(version, spec))
	if code != 201 {
		f.t.Fatalf("template v%d: %d %s", version+1, code, raw)
	}
}
func (f templateReviewFixture) selectTemplate(spec reuse.Spec, bindings reuse.Bindings) {
	f.t.Helper()
	f.request("POST", "/api/me/profiles", f.profile, 200)
	f.publish(0, spec)
	f.request("POST", "/api/me/templates/profile-library/select", map[string]any{"mode": "follow", "version": 1, "targetId": f.profile.ID, "bindings": bindings}, 200)
}
func (f templateReviewFixture) saved() (httpapi.Profile, string) {
	f.t.Helper()
	_, raw := f.request("GET", "/api/me/profiles/"+f.profile.ID+"/reveal", nil, 200)
	var p httpapi.Profile
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		f.t.Fatal(err)
	}
	return p, raw
}
func (f templateReviewFixture) preview() (map[string]any, string) {
	f.t.Helper()
	v, raw := f.request("POST", "/api/me/template-bindings/profiles_"+f.profile.ID+"/preview", map[string]any{"version": 2}, 200)
	if v["compatible"] != true {
		f.t.Fatalf("candidate unexpectedly incompatible: %s", raw)
	}
	return v, raw
}
func (f templateReviewFixture) apply(digest any, want int) {
	f.t.Helper()
	f.request("POST", "/api/me/template-bindings/profiles_"+f.profile.ID+"/apply", map[string]any{"version": 2, "previewDigest": digest}, want)
}
func templateReviewSide(t *testing.T, preview map[string]any, side string) (string, *httpapi.FrozenRoutingIntent, string) {
	t.Helper()
	review, ok := preview["review"].(map[string]any)
	if !ok {
		t.Fatal("missing review")
	}
	v, ok := review[side].(map[string]any)
	if !ok {
		t.Fatal("missing review side")
	}
	state, _ := v["state"].(string)
	reason, _ := v["reason"].(string)
	var intent *httpapi.FrozenRoutingIntent
	if v["intent"] != nil {
		b, _ := json.Marshal(v["intent"])
		if err := json.Unmarshal(b, &intent); err != nil {
			t.Fatal(err)
		}
	}
	return state, intent, reason
}
func simpleReviewSpec() reuse.Spec {
	return reuse.Spec{DefaultAction: domain.ActionRef{Kind: "direct"}, Runtime: domain.ClientRuntime{MixedPort: 7890}}
}
func reviewRule(id, value, action string) domain.PolicyRule {
	return domain.PolicyRule{ID: id, Match: domain.MatchExpression{Op: "domain-suffix", Value: value}, Action: domain.ActionRef{Kind: action}}
}

func TestTemplateRoutingReviewPreservesActualLocalEditsDeletionAndOrder(t *testing.T) {
	f := newTemplateReviewFixture(t, templateTestProfile("preserved", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}))
	spec := simpleReviewSpec()
	spec.Rules = []domain.PolicyRule{reviewRule("first", "first.example", "direct"), reviewRule("personal", "personal.example", "direct"), reviewRule("deleted", "deleted.example", "direct")}
	f.selectTemplate(spec, reuse.Bindings{})
	personal, _ := f.saved()
	personal.IR.Rules = []domain.PolicyRule{reviewRule("personal", "my.example", "reject"), reviewRule("first", "first.example", "direct")}
	saveCurrentProfileDraft(t, f.user, f.srv.URL+"/api/me/profiles/"+f.profile.ID, personal)
	spec.Rules = []domain.PolicyRule{reviewRule("first", "upstream.example", "reject"), reviewRule("personal", "upstream-personal.example", "direct"), reviewRule("deleted", "deleted.example", "reject"), reviewRule("new", "new.example", "direct")}
	f.publish(1, spec)
	_, stored := f.saved()
	v, _ := f.preview()
	_, current, _ := templateReviewSide(t, v, "current")
	_, candidate, _ := templateReviewSide(t, v, "candidate")
	if current == nil || candidate == nil || len(current.Rules) != 2 || len(candidate.Rules) != 3 {
		t.Fatal("actual local/candidate rule coverage lost")
	}
	if current.Rules[0].ID != "personal" || candidate.Rules[0].ID != "personal" || candidate.Rules[1].ID != "first" || candidate.Rules[2].ID != "new" {
		t.Fatal("local ordering did not win with upstream-only addition appended")
	}
	if candidate.Rules[0].Match.Expression.Value != "my.example" || candidate.Rules[0].Action.Kind != "reject" || candidate.Rules[1].Match.Expression.Value != "upstream.example" {
		t.Fatal("review used upstream rather than actual merged candidate")
	}
	kept, _ := json.Marshal(v["preservedLocalEdits"])
	if string(kept) != `["rules/deleted (deleted)","rules/personal"]` {
		t.Fatalf("known preserved report: %s", kept)
	}
	_, unchanged := f.saved()
	if unchanged != stored {
		t.Fatal("preview mutated personal draft")
	}
	f.apply(v["previewDigest"], 200)
	applied, _ := f.saved()
	if len(applied.IR.Rules) != 3 || applied.IR.Rules[0].Match.Value != "my.example" || applied.IR.Rules[0].Action.Kind != "reject" {
		t.Fatal("applied draft differs from preserved candidate")
	}
	for _, r := range applied.IR.Rules {
		if r.ID == "deleted" {
			t.Fatal("personal deletion was resurrected")
		}
	}
}

func TestTemplateRoutingReviewUnavailableCurrentDoesNotBlockValidRepair(t *testing.T) {
	f := newTemplateReviewFixture(t, templateTestProfile("repair", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}))
	spec := simpleReviewSpec()
	spec.Groups = []reuse.Group{{ID: "gone", Name: "Old group", Kind: "manual", Members: []domain.ActionRef{{Kind: "direct"}}}}
	spec.Rules = []domain.PolicyRule{{ID: "repair-rule", Match: domain.MatchExpression{Op: "domain-suffix", Value: "repair.example"}, Action: domain.ActionRef{Kind: "group", Ref: "gone"}}}
	f.selectTemplate(spec, reuse.Bindings{})
	broken, _ := f.saved()
	broken.IR.Groups = nil
	saveCurrentProfileDraft(t, f.user, f.srv.URL+"/api/me/profiles/"+f.profile.ID, broken)
	saved, stored := f.saved()
	if len(saved.Diagnostics) == 0 {
		t.Fatal("repair fixture did not persist an invalid current draft")
	}
	spec.Rules[0].Action = domain.ActionRef{Kind: "direct"}
	f.publish(1, spec)
	v, _ := f.preview()
	state, current, reason := templateReviewSide(t, v, "current")
	if state != "unavailable" || current != nil || reason != "render-failed" {
		t.Fatal("invalid current invented usable comparison")
	}
	state, candidate, _ := templateReviewSide(t, v, "candidate")
	if state != "available" || candidate == nil || candidate.Rules[0].Action.Kind != "direct" {
		t.Fatal("valid repair lost its candidate summary")
	}
	if len(v["diagnostics"].([]any)) != 0 {
		t.Fatal("advisory before-render error leaked into candidate diagnostics")
	}
	_, unchanged := f.saved()
	if unchanged != stored {
		t.Fatal("preview repaired draft without explicit apply")
	}
	f.apply(v["previewDigest"], 200)
	applied, _ := f.saved()
	if len(applied.Diagnostics) != 0 || applied.IR.Rules[0].Action.Kind != "direct" {
		t.Fatal("valid repair was not applied")
	}
}

func TestTemplateRoutingReviewMaterializedResourceSnapshotStableAndFenced(t *testing.T) {
	f := newTemplateReviewFixture(t, templateTestProfile("resource-review", render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}))
	accept := func(name, domainName string) {
		t.Helper()
		f.request("POST", "/api/me/resources/import", map[string]any{"resource": map[string]any{"id": "rules", "name": name, "format": "sing-box-source", "updatePolicy": "follow"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte(`{"version":5,"rules":[{"domain_suffix":["` + domainName + `"]}]}`))}, 201)
	}
	accept("Old file", "old-private.example")
	f.profile.IR.Resources = []domain.RuleResource{{ID: "rules"}}
	spec := simpleReviewSpec()
	spec.ResourceSlots = []reuse.Slot{{ID: "file", Name: "Owned file"}}
	spec.Rules = []domain.PolicyRule{{ID: "file-rule", Match: domain.MatchExpression{Op: "resource", Value: "file"}, Action: domain.ActionRef{Kind: "direct"}}}
	f.selectTemplate(spec, reuse.Bindings{Resources: map[string]string{"file": "rules"}})
	_, stored := f.saved()
	accept("Current file", "current-private.example")
	spec.Rules[0].Action = domain.ActionRef{Kind: "reject"}
	f.publish(1, spec)
	first, _ := f.preview()
	second, _ := f.preview()
	if first["previewDigest"] != second["previewDigest"] {
		t.Fatal("same captured inputs produced unstable digest")
	}
	for _, field := range []string{"review", "artifacts"} {
		a, _ := json.Marshal(first[field])
		b, _ := json.Marshal(second[field])
		if string(a) != string(b) {
			t.Fatalf("repeated preview changed %s", field)
		}
	}
	for _, side := range []string{"current", "candidate"} {
		_, intent, _ := templateReviewSide(t, first, side)
		if intent == nil || len(intent.Resources) != 1 || intent.Resources[0].ID != "rules" || intent.Resources[0].Label != "Current file" {
			t.Fatalf("%s did not use the same current materialized file", side)
		}
	}
	_, unchanged := f.saved()
	if unchanged != stored {
		t.Fatal("resource materialization rewrote persisted draft during preview")
	}
	reviewBytes, err := json.Marshal(first["review"])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(reviewBytes), "current-private.example") {
		t.Fatal("template review exposed private rule-file contents")
	}
	accept("Newer file", "newer-private.example")
	f.apply(first["previewDigest"], 409)
	_, unchanged = f.saved()
	if unchanged != stored {
		t.Fatal("stale resource apply mutated draft")
	}
	fresh, _ := f.preview()
	if fresh["previewDigest"] == first["previewDigest"] {
		t.Fatal("changed captured resource did not invalidate digest")
	}
	f.apply(fresh["previewDigest"], 200)
	applied, _ := f.saved()
	if applied.IR.Resources[0].Name != "Newer file" {
		t.Fatal("fresh apply did not materialize reviewed resource")
	}
}

func TestTemplateRoutingReviewReusesSensitiveMatchAndByteBounds(t *testing.T) {
	p := templateTestProfile("bounded-review", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
	p.IR.Endpoints[0].Connection.Password = "sensitive.example"
	p.IR.Endpoints[0].Name = "secret sensitive.example label"
	f := newTemplateReviewFixture(t, p)
	spec := simpleReviewSpec()
	spec.EndpointSlots = []reuse.Slot{{ID: "exit", Name: "Exit"}}
	spec.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "exit"}
	spec.Rules = []domain.PolicyRule{reviewRule("sensitive", "sensitive.example", "direct")}
	children := []domain.MatchExpression{}
	for i := 0; i < 300; i++ {
		children = append(children, domain.MatchExpression{Op: "domain", Value: fmt.Sprintf("nested-%d.example", i)})
	}
	spec.Rules = append(spec.Rules, domain.PolicyRule{ID: "large", Match: domain.MatchExpression{Op: "or", Children: children}, Action: domain.ActionRef{Kind: "direct"}})
	for i := 0; i < 600; i++ {
		spec.Rules = append(spec.Rules, reviewRule(fmt.Sprintf("rule-%d", i), fmt.Sprintf("%05d.%s.example", i, strings.Repeat("a", 60)), "direct"))
	}
	f.selectTemplate(spec, reuse.Bindings{Endpoints: map[string]string{"exit": "node"}})
	spec.DefaultAction = domain.ActionRef{Kind: "direct"}
	f.publish(1, spec)
	v, _ := f.preview()
	for _, side := range []string{"current", "candidate"} {
		_, intent, _ := templateReviewSide(t, v, side)
		if intent == nil {
			t.Fatal("bounded review missing intent")
		}
		encoded, _ := json.Marshal(intent)
		if len(encoded) > 64<<10 || intent.RuleCount != 602 || intent.OmittedRuleCount <= 0 || len(intent.Rules)+intent.OmittedRuleCount != 602 {
			t.Fatal("template summary violated existing64KiB coverage contract")
		}
		if intent.Rules[0].Match.State != "omitted" || intent.Rules[0].Match.Reason != "sensitive" || intent.Rules[0].Match.Expression != nil {
			t.Fatal("sensitive match was altered or exposed")
		}
		if intent.Rules[1].Match.State != "omitted" || intent.Rules[1].Match.Reason != "size-limit" || intent.Rules[1].Match.Expression != nil {
			t.Fatal("oversized match was not explicitly omitted")
		}
		for _, secret := range []string{"sensitive.example", "private-user", "192.0.2.9", "connection", "password"} {
			if strings.Contains(string(encoded), secret) {
				t.Fatalf("review projection leaked %q", secret)
			}
		}
	}
	artifact := v["artifacts"].([]any)[0].(map[string]any)["content"].(string)
	if !strings.Contains(artifact, "nested-299.example") || !strings.Contains(artifact, "00599.") {
		t.Fatal("summary bounds truncated actual candidate policy")
	}
}
