package render_test

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func principalProgram(adapter, version string) domain.ServerProgram {
	return domain.ServerProgram{Instance: domain.CoreInstance{ID: "ingress", HostID: "host", AdapterID: adapter, Version: version}, Listener: domain.ManagedEndpoint{ID: "entry", InstanceID: "ingress", Name: "Entry", Connection: domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 12345}}, Principals: []domain.ServerPrincipal{
		{SubjectID: "sub_alice_opaque", AccountID: "alice", RouteID: "direct", CredentialVersion: "v1", Credential: domain.PrincipalCredential{UUID: "00000000-0000-4000-8000-000000000001"}, Action: domain.ActionRef{Kind: "direct"}, PolicyRevision: "policy1", CycleID: "cycle1"},
		{SubjectID: "sub_bob_opaque", AccountID: "bob", RouteID: "blocked", CredentialVersion: "v1", Credential: domain.PrincipalCredential{UUID: "00000000-0000-4000-8000-000000000002"}, Action: domain.ActionRef{Kind: "reject"}, PolicyRevision: "policy1", CycleID: "cycle1"},
	}}
}
func TestMultipleAuthenticatedPrincipalsHaveOpaqueNativeIdentity(t *testing.T) {
	for _, target := range []struct{ adapter, version string }{{render.ServerAdapterXray, render.XrayVersion}, {render.ServerAdapterSingBox, render.SingBoxVersion}} {
		t.Run(target.adapter, func(t *testing.T) {
			p := principalProgram(target.adapter, target.version)
			artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "deployment", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
			if err != nil {
				t.Fatal(err)
			}
			var config map[string]any
			if err = json.Unmarshal([]byte(artifacts[0].Content), &config); err != nil {
				t.Fatal(err)
			}
			inbound := config["inbounds"].([]any)[0].(map[string]any)
			var users []any
			field := "email"
			if target.adapter == render.ServerAdapterXray {
				users = inbound["settings"].(map[string]any)["clients"].([]any)
			} else {
				users = inbound["users"].([]any)
				field = "name"
			}
			if len(users) != 2 || users[0].(map[string]any)[field] != "sub_alice_opaque" || users[1].(map[string]any)[field] != "sub_bob_opaque" {
				t.Fatalf("authenticated identity missing: %v", users)
			}
			if strings.Contains(artifacts[0].Content, `"accountId"`) {
				t.Fatal("account mapping escaped native sidecar")
			}
		})
	}
}

func TestPrincipalAuthenticationModelsFailClosed(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*domain.ServerProgram)
	}{
		{"mixed listener credential", func(p *domain.ServerProgram) { p.Listener.Connection.UUID = "00000000-0000-4000-8000-000000000099" }},
		{"duplicate native UUID", func(p *domain.ServerProgram) { p.Principals[1].Credential = p.Principals[0].Credential }},
		{"duplicate subject", func(p *domain.ServerProgram) { p.Principals[1].SubjectID = p.Principals[0].SubjectID }},
		{"missing action", func(p *domain.ServerProgram) { p.Principals[1].Action = domain.ActionRef{} }},
		{"unknown connector", func(p *domain.ServerProgram) {
			p.Principals[1].Action = domain.ActionRef{Kind: "forward", Ref: "missing"}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := principalProgram(render.ServerAdapterXray, render.XrayVersion)
			tc.mutate(&p)
			if _, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "test", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}}); err == nil {
				t.Fatal("ambiguous or unauthenticated principal accepted")
			}
		})
	}
}
func TestManagedPrincipalArtifactIsDistinctFromStock(t *testing.T) {
	p := principalProgram(render.ServerAdapterManagedXray, render.ManagedXrayVersion)
	artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "test", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 2 || artifacts[1].Path != "ingress/entry-policy.json" {
		t.Fatalf("missing managed binding sidecar: %v", artifacts)
	}
	var descriptor map[string]any
	if err = json.Unmarshal([]byte(artifacts[1].Content), &descriptor); err != nil {
		t.Fatal(err)
	}
	if descriptor["adapterId"] != render.ServerAdapterManagedXray || descriptor["runtimeVersion"] != render.ManagedXrayVersion {
		t.Fatalf("wrong managed descriptor: %v", descriptor)
	}
	if strings.Contains(artifacts[1].Content, p.Principals[0].Credential.UUID) {
		t.Fatal("credential included in admission sidecar")
	}
	if !(render.ManagedXrayServer{}).ServerCapability().ManagedAccess || (render.XrayServer{}).ServerCapability().ManagedAccess || (render.SingBoxServer{}).ServerCapability().ManagedAccess {
		t.Fatal("stock runtime advertised managed enforcement")
	}
	p.Principals[0].Credential.Flow = "xtls-rprx-vision"
	if _, err = render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "test", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}}); err == nil {
		t.Fatal("unverified managed Vision accepted")
	}
}

func TestManagedDestinationExceptionsAreExplicitAndNotSilentlyDropped(t *testing.T) {
	p := principalProgram(render.ServerAdapterManagedXray, render.ManagedXrayVersion)
	p.DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}
	ir := domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "test", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}}
	artifacts, err := render.DefaultServers().Render(ir)
	if err != nil {
		t.Fatal(err)
	}
	var descriptor map[string]any
	if err = json.Unmarshal([]byte(artifacts[1].Content), &descriptor); err != nil {
		t.Fatal(err)
	}
	allowed := descriptor["destinationPolicy"].(map[string]any)["allowCidrs"].([]any)
	if len(allowed) != 1 || allowed[0] != "127.0.0.1/32" {
		t.Fatal("explicit private target exception was not preserved")
	}
	for _, cidr := range []string{"0.0.0.0/0", "127.0.0.1/8", "not-a-prefix"} {
		ir.Programs[0].DestinationPolicy = &domain.DestinationPolicy{AllowCIDRs: []string{cidr}}
		if _, err = render.DefaultServers().Render(ir); err == nil {
			t.Fatalf("unsafe/noncanonical exception accepted: %s", cidr)
		}
	}
	ir.Programs[0] = p
	ir.Programs[0].Instance.AdapterID = render.ServerAdapterXray
	ir.Programs[0].Instance.Version = render.XrayVersion
	if _, err = render.DefaultServers().Render(ir); err == nil {
		t.Fatal("stock runtime silently dropped resolved-target policy")
	}
}

func TestManagedOutboundMeasurementCannotBeBypassedByUnverifiedModes(t *testing.T) {
	for _, field := range []string{"flow", "reality", "transport", "packet"} {
		for _, placement := range []string{"egress", "connector"} {
			t.Run(placement+"/"+field, func(t *testing.T) {
				p := principalProgram(render.ServerAdapterManagedXray, render.ManagedXrayVersion)
				c := domain.Connection{Protocol: "vless", Host: "127.0.0.1", Port: 12346, UUID: "00000000-0000-4000-8000-000000000099"}
				switch field {
				case "flow":
					c.Flow = "xtls-rprx-vision"
				case "reality":
					c.TLS = &domain.TLSOptions{Enabled: true, Reality: &domain.RealityOptions{}}
				case "transport":
					c.Transport = &domain.TransportOptions{Type: "ws"}
				case "packet":
					c.PacketEncoding = "xudp"
				}
				if placement == "egress" {
					p.Egress = []domain.Connection{c}
				} else {
					p.Connectors = []domain.ServerConnector{{ID: "out", Connection: c}}
				}
				if _, err := (render.ManagedXrayServer{}).RenderServer(p); err == nil {
					t.Fatal("untested outbound bypass mode accepted by managed adapter")
				}
			})
		}
	}
}
