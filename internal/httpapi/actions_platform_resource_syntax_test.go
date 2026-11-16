package httpapi

import (
	"context"
	"routeweaver/internal/domain"
	"routeweaver/internal/resources"
	"strings"
	"testing"
)

func TestSmallRuleJSONSyntaxBudget(t *testing.T) {
	good := []string{`{}`, `{"version":1,"rules":[{"domain":["example.com"]}]}`, `{"a":{"x":1},"b":{"x":2}}`, `{"a":` + strings.Repeat("[", 7) + "0" + strings.Repeat("]", 7) + "}", `{"a":[` + strings.Repeat("0,", 250) + "0]}"}
	for _, v := range good {
		if !smallRuleJSON([]byte(v)) {
			t.Fatalf("valid bounded JSON declined: length %d", len(v))
		}
	}
	bad := []string{`[]`, `null`, `{} {}`, `{} garbage`, `{} []`, `{"x":1,"x":2}`, `{"x":1,"\u0078":2}`, `{"x":{"k":1,"k":2}}`, `{"x":NaN}`, `{"x":`, `{"a":` + strings.Repeat("[", 8) + "0" + strings.Repeat("]", 8) + "}", `{"a":[` + strings.Repeat("0,", 251) + "0]}", string([]byte{'{', '"', 0xff, '"', ':', '1', '}'})}
	for i, v := range bad {
		if smallRuleJSON([]byte(v)) {
			t.Fatalf("unsafe JSON admitted case %d", i)
		}
	}
	if !smallRuleJSON([]byte("{}"+strings.Repeat(" ", 4094))) || smallRuleJSON([]byte("{}"+strings.Repeat(" ", 4095))) {
		t.Fatal("byte boundary")
	}
}
func TestSmallRuleYAMLFlatQuotedSubset(t *testing.T) {
	good := []string{"payload:\n  - \"example.com\"\n", "payload:\r\n  - \"*.example.com\"\r\n", "payload:\n  - \"literal &anchor *alias !tag [ ] :\"\n", "payload:\n" + strings.Repeat("  - \"a\"\n", 64), "payload:\n  - \"" + strings.Repeat("a", 256) + "\"\n"}
	for i, v := range good {
		if !smallRuleYAML([]byte(v)) {
			t.Fatalf("valid subset declined %d", i)
		}
	}
	bad := []string{"payload:\n  - \"a\"\npayload:\n  - \"b\"\n", "payload:\n  - \"\\u2028\"\n", "payload:\n  - \"\\u2029\"\n", "payload:\n  - \"line\\nnext\"\n", "payload:\n  - \"\\u000a\"\n", "payload:\n  - \"\\u0000\"\n", "payload: [example.com]\n", "payload:\n  - example.com\n", "payload:\n  - &a \"example.com\"\n", "payload:\n  - *a\n", "payload:\n  - !str \"a\"\n", "payload:\n  - |\n    value\n", "payload:\n  - \"a\"\n---\npayload: []\n", "payload:\n    - \"a\"\n", "payload:\n\t- \"a\"\n", "payload:\n  - [\"a\"]\n", "payload:\n  - {key: \"a\"}\n", "payload:\n  - \"a\" #comment\n", "payload:\n  - \"unterminated\n", "payload:\n" + strings.Repeat("  - \"a\"\n", 65), "payload:\n  - \"" + strings.Repeat("a", 257) + "\"\n", "payload:\n  - \"a\"\nextra: \"x\"\n"}
	for i, v := range bad {
		if smallRuleYAML([]byte(v)) {
			t.Fatalf("unsupported YAML admitted %d", i)
		}
	}
}
func TestSmallPlatformResourceSubsetDoesNotNarrowManualReview(t *testing.T) {
	for _, format := range []string{"mihomo-yaml", "sing-box-source"} {
		t.Run(format, func(t *testing.T) {
			h, out, p, _ := platformResourceCaptureFixture(t, format)
			body := []byte("payload: [example.com, example.org]\n")
			if format == "sing-box-source" {
				body = []byte(`{"version":1,"rules":[{"domain":[` + strings.Repeat(`"example.com",`, 250) + `"example.org"]}]}`)
			}
			f, e := resources.AcceptRuleFile(domain.RuleResource{ID: "rules", OwnerID: "owner", Format: format, Behavior: "domain", UpdatePolicy: "follow"}, body)
			if e != nil {
				t.Fatal(e)
			}
			putPlatformResource(t, h, f)
			// Existing explicit prepare path remains functional and freezes exact bytes.
			prepared, e := h.prepareOutput("owner", out, newTemplateInputs(h.s))
			if e != nil {
				t.Fatal("manual review narrowed", e)
			}
			if len(prepared.output.ResourceFiles) != 1 || string(prepared.output.ResourceFiles[0].Body) != string(body) {
				t.Fatal("manual bytes changed")
			}
			b := 2 << 20
			got := h.compareSmallPlatformDraft(context.Background(), "owner", out, &b)
			if got["state"] != "unavailable" {
				t.Fatal("unsupported subset auto-admitted", got, p.ID)
			}
		})
	}
}
