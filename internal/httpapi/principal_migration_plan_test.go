package httpapi

import (
	"encoding/json"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func migrationPlanFixture() (domain.ServerDeploymentIR, domain.ServerDeploymentIR) {
	p := domain.ServerPrincipal{SubjectID: "old-sub", AccountID: "existing", RouteID: "route", CredentialVersion: "v1", Credential: domain.PrincipalCredential{UUID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}
	before := domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "deployment", TopologyRevision: "topology", Programs: []domain.ServerProgram{{Instance: domain.CoreInstance{ID: "core", AdapterID: render.ServerAdapterManagedXray, Version: render.ManagedXrayVersion}, Listener: domain.ManagedEndpoint{ID: "entry", Authentication: "principals"}, Principals: []domain.ServerPrincipal{p}}}}
	raw, _ := json.Marshal(before)
	var after domain.ServerDeploymentIR
	json.Unmarshal(raw, &after)
	after.Programs[0].Principals = append(after.Programs[0].Principals, domain.ServerPrincipal{SubjectID: "new-sub", AccountID: "requester", RouteID: "route", CredentialVersion: "v2", Credential: domain.PrincipalCredential{UUID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}})
	return before, after
}
func TestPrincipalMigrationConfinement(t *testing.T) {
	before, after := migrationPlanFixture()
	added, e := validatePrincipalAddition(before, after, "requester", map[string]bool{"route": true}, 2)
	if e != nil || len(added) != 1 {
		t.Fatalf("addition rejected: %v", e)
	}
	for _, tc := range []struct {
		name   string
		mutate func(*domain.ServerDeploymentIR)
	}{
		{"existing credential", func(v *domain.ServerDeploymentIR) { v.Programs[0].Principals[0].Credential.UUID = "changed" }},
		{"listener", func(v *domain.ServerDeploymentIR) { v.Programs[0].Listener.Connection.Host = "other" }},
		{"metadata", func(v *domain.ServerDeploymentIR) { v.TopologyRevision = "other" }},
		{"other owner", func(v *domain.ServerDeploymentIR) { v.Programs[0].Principals[1].AccountID = "other" }},
		{"other route", func(v *domain.ServerDeploymentIR) { v.Programs[0].Principals[1].RouteID = "other" }},
		{"credential reuse", func(v *domain.ServerDeploymentIR) {
			v.Programs[0].Principals[1].Credential.UUID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
		}},
		{"subject reuse", func(v *domain.ServerDeploymentIR) { v.Programs[0].Principals[1].SubjectID = "old-sub" }},
		{"deleted principal", func(v *domain.ServerDeploymentIR) { v.Programs[0].Principals = v.Programs[0].Principals[1:] }},
		{"extra program", func(v *domain.ServerDeploymentIR) { v.Programs = append(v.Programs, v.Programs[0]) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, a := migrationPlanFixture()
			tc.mutate(&a)
			if _, err := validatePrincipalAddition(b, a, "requester", map[string]bool{"route": true}, 2); err == nil {
				t.Fatal("unsafe delta accepted")
			}
		})
	}
}

func TestPrincipalMigrationReceiptSizeIsBounded(t *testing.T) {
	p := preparedPrincipalMigration{Receipt: principalServiceMigration{OldDesired: map[string]controlprotocol.Desired{"core": {Artifacts: []domain.Artifact{{Path: "config.json", Content: strings.Repeat("x", maxPrincipalMigrationRecordBytes)}}}}}}
	if _, err := p.build(map[string]uint64{}); err == nil {
		t.Fatal("oversized recovery evidence accepted")
	}
}
