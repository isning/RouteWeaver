package resources_test

import (
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/resources"
)

func TestAcceptedRuleFileIntegrityAndEnvelopeLimits(t *testing.T) {
	r := domain.RuleResource{ID: "owned", OwnerID: "owner", Format: "sing-box-source", UpdatePolicy: "pinned"}
	file, err := resources.AcceptRuleFile(r, []byte(`{"version":5,"rules":[{"domain":["owned.example"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if file.Resource.SizeBytes != int64(len(file.Body)) || file.Resource.FormatVersion != 5 || file.Resource.AcceptedVersion == "" || file.Resource.Path == "" {
		t.Fatal("incomplete immutable file descriptor")
	}
	if err = resources.VerifyRuleFile(file); err != nil {
		t.Fatal(err)
	}
	tampered := file
	tampered.Body = []byte(`{"version":5,"rules":[]}`)
	if resources.VerifyRuleFile(tampered) == nil {
		t.Fatal("modified accepted bytes passed integrity")
	}
	tampered = file
	tampered.Resource.Path = "../../etc/passwd"
	if resources.VerifyRuleFile(tampered) == nil {
		t.Fatal("tampered generated path accepted")
	}
	tampered = file
	tampered.Resource.SizeBytes++
	if resources.VerifyRuleFile(tampered) == nil {
		t.Fatal("tampered accepted size")
	}
	for _, tc := range []struct{ name, format, body string }{
		{"html", "sing-box-source", "<html>login</html>"},
		{"yaml aliases", "mihomo-yaml", "payload: &x [one]\nextra: *x\n"},
		{"yaml documents", "mihomo-yaml", "payload: [one]\n---\npayload: [two]\n"},
		{"excessive depth", "sing-box-source", `{"version":5,"rules":[{"x":` + strings.Repeat("[", 70) + `1` + strings.Repeat("]", 70) + `}]}`},
		{"excessive bytes", "mihomo-text", strings.Repeat("a", resources.MaxRuleFileBytes+1)},
		{"fake srs", "srs", "<html>error</html>"},
		{"fake mrs", "mrs", "not compressed rule data"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, e := resources.InspectRuleFile(tc.format, []byte(tc.body)); e == nil {
				t.Fatal("invalid envelope accepted")
			}
		})
	}
}
