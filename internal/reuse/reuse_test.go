package reuse_test

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/reuse"
	"strings"
	"testing"
)

func TestProcessingUpgradePreservesPersonalEditsAndDeletes(t *testing.T) {
	old := []domain.ProcessingStep{{ID: "rename", Enabled: true, Kind: "rename", Template: "{name}"}, {ID: "sort", Enabled: true, Kind: "sort", SortBy: "name"}}
	local := []domain.ProcessingStep{{ID: "rename", Enabled: true, Kind: "rename", Template: "Mine {name}"}, {ID: "personal", Enabled: true, Kind: "deduplicate"}}
	upstream := []domain.ProcessingStep{{ID: "rename", Enabled: true, Kind: "rename", Template: "Shared {name}"}, {ID: "sort", Enabled: true, Kind: "sort", SortBy: "region"}, {ID: "added", Enabled: true, Kind: "deduplicate"}}
	got, preserved := reuse.MergeSteps(old, local, upstream)
	if len(got) != 3 || got[0].ID != "rename" || got[0].Template != "Mine {name}" || got[1].ID != "personal" || got[2].ID != "added" {
		t.Fatalf("personal changes/deletion lost: %+v", got)
	}
	if len(preserved) == 0 {
		t.Fatal("preview must identify preserved personal edits")
	}
	got[0].Template = "mutated"
	if local[0].Template != "Mine {name}" {
		t.Fatal("merge aliases personal input")
	}
}

func TestSanitizedProfileNeverCopiesConnectionOrResourceSecrets(t *testing.T) {
	profile := domain.ClientProfileIR{Endpoints: []domain.ClientEndpoint{{ID: "private-endpoint", OwnerID: "alice", Name: "Node", Connection: domain.Connection{Host: "private-host", Password: "password-secret"}}}, Resources: []domain.RuleResource{{ID: "private-rules", URL: "https://example.test/private-token", OwnerID: "alice"}}, Groups: []domain.PolicyGroup{{ID: "proxy", Name: "Proxy", Kind: "manual", Members: []domain.ActionRef{{Kind: "endpoint", Ref: "private-endpoint"}}}}, Rules: []domain.PolicyRule{{ID: "rules", Match: domain.MatchExpression{Op: "resource", Value: "private-rules"}, Action: domain.ActionRef{Kind: "group", Ref: "proxy"}}}, DefaultAction: domain.ActionRef{Kind: "group", Ref: "proxy"}}
	spec, err := reuse.SanitizeProfile(profile)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(spec)
	for _, secret := range []string{"private-endpoint", "private-host", "password-secret", "private-token", "alice", "private-rules"} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("shared spec contains %q: %s", secret, b)
		}
	}
	if len(spec.EndpointSlots) != 1 || len(spec.ResourceSlots) != 1 {
		t.Fatal("private dependencies must become explicit binding slots")
	}
}

func TestDynamicTemplateSelectionIsValidatedAgainstActualTenantEndpoints(t *testing.T) {
	spec := reuse.Spec{Groups: []reuse.Group{{ID: "regional", Name: "Regional", Kind: "manual", Dynamic: &reuse.Filter{Region: "JP"}}}, DefaultAction: domain.ActionRef{Kind: "group", Ref: "regional"}}
	if e := reuse.Validate(reuse.ClientProfile, spec); e != nil {
		t.Fatalf("dynamic declaration cannot require private library sample nodes: %v", e)
	}
	p := domain.ClientProfileIR{SchemaVersion: "1.0", ID: "profile", OwnerID: "user", Name: "Profile", Revision: "1", Endpoints: []domain.ClientEndpoint{{ID: "node", Name: "Node", Region: "US", OwnerID: "user", Origin: "imported", Connection: domain.Connection{Host: "192.0.2.1", Port: 1080, Protocol: "socks"}}}}
	candidate, e := spec.Instantiate(p, reuse.Bindings{})
	if e != nil {
		t.Fatal(e)
	}
	if e = domain.ValidateClientProfile(candidate); e == nil {
		t.Fatal("actual empty dynamic selection silently accepted")
	}
}

func TestSanitizeRejectsPrivateSourceFiltersAndConnectionOverrides(t *testing.T) {
	host := "private.example"
	_, e := reuse.SanitizeSteps([]domain.ProcessingStep{{ID: "override", Kind: "override", Enabled: true, Override: domain.EndpointOverride{Host: &host}}})
	if e == nil {
		t.Fatal("private host override shared")
	}
	_, e = reuse.SanitizeSteps([]domain.ProcessingStep{{ID: "filter", Kind: "keep", Enabled: true, Filter: domain.EndpointFilter{SourceID: "private-source"}}})
	if e == nil {
		t.Fatal("source-specific filter silently broadened")
	}
}
