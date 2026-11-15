package httpapi

import (
	"context"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/resources"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func platformResourceCaptureFixture(t *testing.T, format string) (*server, Output, Profile, resources.RuleFile) {
	t.Helper()
	h, out := platformCaptureFixture(t)
	var p Profile
	if e := h.s.TenantGet("owner", "profiles", "profile", &p); e != nil {
		t.Fatal(e)
	}
	body := []byte("old.example\n")
	if format == "srs" {
		body = []byte{'S', 'R', 'S', 1, 0}
		p.Target = render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
		out.Target = p.Target
	}
	if format == "mrs" {
		body = []byte{0x28, 0xb5, 0x2f, 0xfd, 0}
	}
	file, e := resources.AcceptRuleFile(domain.RuleResource{ID: "rules", OwnerID: "owner", Format: format, Behavior: "domain", UpdatePolicy: "follow"}, body)
	if e != nil {
		t.Fatal(e)
	}
	putPlatformResource(t, h, file)
	p.IR.Resources = []domain.RuleResource{file.Resource}
	p.IR.Rules = []domain.PolicyRule{{ID: "rule", Match: domain.MatchExpression{Op: "resource", Value: "rules"}, Action: domain.ActionRef{Kind: "reject"}}}
	if e = h.s.TenantPut("owner", "profiles", p.ID, p); e != nil {
		t.Fatal(e)
	}
	budget := 2 << 20
	snapshot, e := h.s.PlatformComparisonSnapshot(context.Background(), "owner", time.Now(), &budget)
	if e != nil {
		t.Fatal(e)
	}
	inputs := newTemplateInputs(h.s)
	inputs.platform = &platformComparisonReader{snapshot: snapshot}
	if !withinPlatformResourceBudget("owner", p, inputs) {
		t.Fatal("fixture outside budget")
	}
	prepared, e := h.prepareOutput("owner", out, inputs)
	if e != nil {
		t.Fatal(e)
	}
	out = prepared.output
	if len(out.ResourceFiles) != 1 || !reflect.DeepEqual(out.ResourceFiles[0].Body, body) {
		t.Fatal("baseline did not freeze real bytes")
	}
	if e = h.s.TenantPut("owner", "outputs", out.ID, out); e != nil {
		t.Fatal(e)
	}
	savedID := out.ID
	out = Output{}
	if e = h.s.TenantGet("owner", "outputs", savedID, &out); e != nil {
		t.Fatal(e)
	}
	return h, out, p, file
}
func putPlatformResource(t *testing.T, h *server, file resources.RuleFile) {
	t.Helper()
	for _, v := range []struct {
		kind, id string
		value    any
	}{{"resources", file.Resource.ID, ownedRuleResource{RuleResource: file.Resource, RefreshStatus: "accepted"}}, {"resource-versions", file.Resource.AcceptedVersion, file}} {
		if e := h.s.TenantPut("owner", v.kind, v.id, v.value); e != nil {
			t.Fatal(e)
		}
	}
}
func TestSmallPlatformResourceComparisonRealRender(t *testing.T) {
	for _, format := range []string{"mihomo-text", "srs", "mrs"} {
		t.Run(format, func(t *testing.T) {
			h, out, p, file := platformResourceCaptureFixture(t, format)
			check := func(want string) {
				t.Helper()
				b := 2 << 20
				got := h.compareSmallPlatformDraft(context.Background(), "owner", out, &b)
				if got["state"] != want {
					t.Fatalf("want %s got %v", want, got)
				}
				var saved Output
				if e := h.s.TenantGet("owner", "outputs", out.ID, &saved); e != nil || !reflect.DeepEqual(out, saved) {
					t.Fatal("comparison changed publication", e)
				}
			}
			check("unchanged")
			body := append(append([]byte(nil), file.Body...), byte('x'))
			ref := domain.RuleResource{ID: "rules", OwnerID: "owner", Format: format, Behavior: "domain", UpdatePolicy: "follow"}
			newer, e := resources.AcceptRuleFile(ref, body)
			if e != nil {
				t.Fatal(e)
			}
			putPlatformResource(t, h, newer)
			check("changed")
			p.IR.Resources[0].UpdatePolicy = "pinned"
			if e = h.s.TenantPut("owner", "profiles", p.ID, p); e != nil {
				t.Fatal(e)
			}
			check("unchanged")
			head := ownedRuleResource{RuleResource: newer.Resource, RefreshStatus: "failed"}
			if e = h.s.TenantPut("owner", "resources", "rules", head); e != nil {
				t.Fatal(e)
			}
			check("unavailable")
		})
	}
}
func TestSmallPlatformResourceComparisonExcludesOversizedAndParsedFormats(t *testing.T) {
	for _, mode := range []string{"large", "yaml", "json"} {
		t.Run(mode, func(t *testing.T) {
			h, out, _, _ := platformResourceCaptureFixture(t, "mihomo-text")
			format := "mihomo-text"
			body := []byte(strings.Repeat("x", 4097))
			if mode == "yaml" {
				format = "mihomo-yaml"
				body = []byte("payload: [example.com]\n")
			}
			if mode == "json" {
				format = "sing-box-source"
				body = []byte(`{"version":1,"rules":[{"domain":["example.com"]}]}`)
			}
			f, e := resources.AcceptRuleFile(domain.RuleResource{ID: "rules", OwnerID: "owner", Format: format, Behavior: "domain", UpdatePolicy: "follow"}, body)
			if e != nil {
				t.Fatal(e)
			}
			putPlatformResource(t, h, f)
			b := 2 << 20
			if got := h.compareSmallPlatformDraft(context.Background(), "owner", out, &b); got["state"] != "unavailable" {
				t.Fatal(got)
			}
		})
	}
}
func TestSmallPlatformResourceComparisonSecondCaptureFence(t *testing.T) {
	for _, mode := range []string{"head", "version", "membership"} {
		t.Run(mode, func(t *testing.T) {
			h, out, _, file := platformResourceCaptureFixture(t, "mihomo-text")
			calls := 0
			b := 2 << 20
			capture := func(ctx context.Context, owner string, now time.Time, budget *int) (*store.PlatformComparisonSnapshot, error) {
				calls++
				if calls == 2 {
					switch mode {
					case "head":
						if e := h.s.TenantPut(owner, "resources", "rules", ownedRuleResource{RuleResource: file.Resource, RefreshStatus: "failed"}); e != nil {
							return nil, e
						}
					case "version":
						file.Body = []byte("tampered")
						if e := h.s.TenantPut(owner, "resource-versions", file.Resource.AcceptedVersion, file); e != nil {
							return nil, e
						}
					case "membership":
						if e := h.s.TenantPut(owner, "resource-versions", "extra", file); e != nil {
							return nil, e
						}
					}
				}
				return h.s.PlatformComparisonSnapshot(ctx, owner, now, budget)
			}
			got := h.compareSmallPlatformDraftUsing(context.Background(), "owner", out, &b, capture)
			if calls != 2 || got["state"] != "unavailable" {
				t.Fatalf("calls=%d result=%v", calls, got)
			}
		})
	}
}
