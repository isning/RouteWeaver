package render_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

func TestClientSemanticSnapshotCapturesResolvedGroupsAndEmittedNodes(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			p := clientProfile()
			p.Groups[0].Members = []domain.ActionRef{{Kind: "endpoint", Ref: "us"}, {Kind: "direct"}}
			p.Groups[0].Dynamic = &domain.EndpointFilter{}
			got, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			if got.Semantics == nil || got.Semantics.Version != 1 || got.Semantics.Groups.State != "available" || got.Semantics.Nodes.State != "available" {
				t.Fatal("portable full output lacks comparison evidence")
			}
			groups := got.Semantics.Groups.Items
			want := []domain.ActionRef{{Kind: "endpoint", Ref: "us"}, {Kind: "direct"}, {Kind: "endpoint", Ref: "uk"}}
			if len(groups) != 1 || groups[0].ID != "manual" || groups[0].Label != "Choose" || groups[0].Kind != "manual" || !reflect.DeepEqual(groups[0].Members, want) {
				t.Fatalf("resolved members lost identity/order: %#v", groups)
			}
			if len(got.Semantics.Nodes.Items) != 2 || got.Semantics.Nodes.Items[1].ID != "us" || len(got.Semantics.Nodes.Items[1].SettingsDigest) != 64 {
				t.Fatal("emitted node settings not captured")
			}
			wire, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(wire), "settingsDigest") || strings.Contains(string(wire), "categoryDigests") {
				t.Fatal("private comparison fingerprints leaked through renderer JSON")
			}
			private, _ := json.Marshal(got.Semantics)
			if strings.Contains(string(private), "synthetic-fixture-secret") || strings.Contains(string(private), "192.0.2.20") {
				t.Fatal("snapshot duplicates connection values instead of private fingerprints")
			}
		})
	}
}

func TestClientSemanticSnapshotTracksEmittedNotUnusedOrNormalizedSettings(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			p := clientProfile()
			p.Endpoints[0].Connection = domain.Connection{Host: "example.org", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", TLS: &domain.TLSOptions{Enabled: true, Fingerprint: "chrome"}}
			before, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			p.Endpoints[0].Connection.TLS.Fingerprint = "Chrome"
			// Manual groups do not emit these otherwise-valid parameters.
			p.Groups[0].TestURL = "https://different.example/check"
			p.Groups[0].IntervalSeconds = 900
			p.Groups[0].ToleranceMS = 42
			p.Groups[0].Strategy = "sticky-sessions"
			after, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before.Semantics, after.Semantics) || before.Artifacts[0].Content != after.Artifacts[0].Content {
				t.Fatal("unemitted/normalized inputs invented a change")
			}
			p.Endpoints[0].Connection.UUID = "00000000-0000-4000-8000-000000000002"
			changed, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			a, b := after.Semantics.Nodes.Items[0], changed.Semantics.Nodes.Items[0]
			if a.SettingsDigest == b.SettingsDigest || a.CategoryDigests["authentication"] == b.CategoryDigests["authentication"] {
				t.Fatal("credential-only change was missed")
			}
			for _, category := range []string{"endpoint", "protocol", "security", "transport", "protocol-options"} {
				if a.CategoryDigests[category] != b.CategoryDigests[category] {
					t.Fatalf("credential-only edit changed %s", category)
				}
			}
			p.Endpoints[0].Connection.Transport = &domain.TransportOptions{Type: "tcp"}
			tcp, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			same := changed.Semantics.Nodes.Items[0].SettingsDigest == tcp.Semantics.Nodes.Items[0].SettingsDigest
			if same != (target.AdapterID == "sing-box") {
				t.Fatal("TCP comparison must follow the exact adapter emission")
			}
		})
	}
}

func TestClientSemanticSnapshotSeparatesMembershipStrategyAndParameters(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	p := clientProfile()
	p.Groups[0].Kind = "load-balance"
	p.Groups[0].Strategy = "round-robin"
	p.Groups[0].TestURL = "https://example.org/check"
	p.Groups[0].IntervalSeconds = 300
	before, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatal(err)
	}
	p.Groups[0].Strategy = "sticky-sessions"
	after, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatal(err)
	}
	a, b := before.Semantics.Groups.Items[0], after.Semantics.Groups.Items[0]
	if a.Strategy != "round-robin" || b.Strategy != "sticky-sessions" || a.ParametersDigest != b.ParametersDigest || !reflect.DeepEqual(a.Members, b.Members) {
		t.Fatal("balancing strategy conflated with membership/parameters")
	}
	p.Groups[0].TestURL = "https://example.org/check?token=new-private-value"
	changed, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatal(err)
	}
	if changed.Semantics.Groups.Items[0].ParametersDigest == b.ParametersDigest {
		t.Fatal("emitted probe settings change missed")
	}
	encoded, _ := json.Marshal(changed.Semantics)
	if strings.Contains(string(encoded), "new-private-value") {
		t.Fatal("private probe URL copied to semantic snapshot")
	}
}

func TestClientSemanticSnapshotHasNoPortableClaimsForNativeOrNodesOnly(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		p := clientProfile()
		nodes, err := render.DefaultClients().Render(p, target, render.NodesOnly)
		if err != nil || nodes.Semantics != nil {
			t.Fatal("new full comparison must not replace nodes-only behavior", err)
		}
		patch := `{"log-level":"info"}`
		if target.AdapterID == "sing-box" {
			patch = `{"log":{"level":"info"}}`
		}
		p = withNative(t, p, target, "json", patch, "prepend")
		native, err := render.DefaultClients().Render(p, target, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		if native.Semantics != nil || native.NativeOverride == nil {
			t.Fatal("pre-override capture presented as final delivered semantics")
		}
	}
}

func TestClientSemanticSnapshotBudgetDoesNotReduceRenderCapacity(t *testing.T) {
	p := clientProfile()
	for i := 0; i < 400; i++ {
		node := p.Endpoints[0]
		node.ID, node.Name = fmt.Sprintf("extra-%d", i), fmt.Sprintf("Extra %d", i)
		p.Endpoints = append(p.Endpoints, node)
	}
	result, err := render.DefaultClients().Render(p, render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, render.FullConfig)
	if err != nil {
		t.Fatal("optional comparison lowered rendering capacity", err)
	}
	if result.Semantics.Nodes.State != "unavailable" || result.Semantics.Nodes.Reason != "size-limit" || len(result.Semantics.Nodes.Items) != 0 {
		t.Fatal("oversized category must not look complete or partially empty")
	}
	if result.Semantics.Groups.State != "available" || len(result.Semantics.Groups.Items) != 1 {
		t.Fatal("independent group evidence lost")
	}
	if !strings.Contains(result.Artifacts[0].Content, "Extra 399") {
		t.Fatal("rendered delivery was truncated with comparison")
	}
}

func TestFullConfigSecretInspectionUsesOnlyVerifiedFrozenObjects(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		t.Run(target.AdapterID, func(t *testing.T) {
			p := clientProfile()
			p.Endpoints[0].Connection.Username = "private-user"
			p.Endpoints[0].Connection.Password = "private-password"
			p.Groups = append(p.Groups, domain.PolicyGroup{ID: "auto", Name: "Automatic", Kind: "url-test", Members: []domain.ActionRef{{Kind: "group", Ref: "manual"}}, TestURL: "https://example.org/check?token=private-probe-token#private-fragment", IntervalSeconds: 300, ToleranceMS: 50})
			got, err := render.DefaultClients().Render(p, target, render.FullConfig)
			if err != nil {
				t.Fatal(err)
			}
			secrets, err := render.InspectFullConfigSecrets(target, got.Artifacts, got.NameAllocations)
			if err != nil {
				t.Fatal("accepted emitted full config unavailable", err)
			}
			for _, want := range []string{"private-user", "private-password", "synthetic-fixture-secret", "private-probe-token", "private-fragment"} {
				found := false
				for _, secret := range secrets {
					found = found || secret == want
				}
				if !found {
					t.Fatalf("known emitted credential was not protected: %s", want)
				}
			}
			bad := append([]domain.Artifact(nil), got.Artifacts...)
			bad[0].Content = strings.Replace(bad[0].Content, `"server": "192.0.2.10"`, `"server": "192.0.2.10", "unexpected_secret": "not-understood"`, 1)
			if _, err = render.InspectFullConfigSecrets(target, bad, got.NameAllocations); err == nil {
				t.Fatal("unknown node shape must not supply partial redaction context")
			}
			if _, err = render.InspectFullConfigSecrets(target, got.Artifacts, nil); err == nil {
				t.Fatal("missing frozen allocation accepted")
			}
		})
	}
}

func TestFullConfigSecretInspectionRejectsMalformedAndUnboundedEvidence(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	p := clientProfile()
	valid, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatal(err)
	}
	body := valid.Artifacts[0].Content
	for name, bad := range map[string]string{
		"duplicate-key":       strings.Replace(body, `"port": 1080`, `"port": 1080, "port": 1081`, 1),
		"trailing-document":   body + `{}`,
		"missing-groups":      strings.Replace(body, `"proxy-groups": [`, `"wrong-groups": [`, 1),
		"unknown-group-field": strings.Replace(body, `"type": "select"`, `"type": "select", "password": "unmodeled"`, 1),
		"foreign-member":      strings.Replace(body, `"United Kingdom",`, `"Foreign",`, 1),
		"deep-runtime":        strings.Replace(body, `"allow-lan": false`, `"allow-lan": `+strings.Repeat(`[`, 18)+`0`+strings.Repeat(`]`, 18), 1),
		"aggregate-values":    strings.Replace(body, `"allow-lan": false`, `"allow-lan": [`+strings.Repeat(`0,`, 1_000_000)+`0]`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			artifacts := []domain.Artifact{{Path: "mihomo.json", Content: bad}}
			if secrets, err := render.InspectFullConfigSecrets(target, artifacts, valid.NameAllocations); err == nil || secrets != nil {
				t.Fatal("unsafe optional inspection returned evidence")
			}
		})
	}
	if _, err := render.InspectFullConfigSecrets(render.Target{AdapterID: "mihomo", Version: "unknown"}, valid.Artifacts, valid.NameAllocations); err == nil {
		t.Fatal("unknown version accepted")
	}
	if _, err := render.InspectFullConfigSecrets(target, []domain.Artifact{{Path: "mihomo-nodes.json", Content: body}}, valid.NameAllocations); err == nil {
		t.Fatal("wrong output mode accepted")
	}
	for _, emptyTarget := range []render.Target{target, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		p.Endpoints, p.Groups, p.Rules = nil, nil, nil
		empty, err := render.DefaultClients().Render(p, emptyTarget, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		secrets, err := render.InspectFullConfigSecrets(emptyTarget, empty.Artifacts, empty.NameAllocations)
		if err != nil || len(secrets) != 0 {
			t.Fatal("known empty config confused with missing evidence", err)
		}
	}
}

func TestFullConfigSecretInspectionLimitsDoNotRejectSupportedRendering(t *testing.T) {
	p := clientProfile()
	for i := 0; i < 33; i++ {
		p.Resources = append(p.Resources, domain.RuleResource{ID: fmt.Sprintf("provider-%d", i), OwnerID: p.OwnerID, Visibility: "public", Revision: "1", Digest: "sha256:" + strings.Repeat("0", 64), Format: "mihomo-yaml", Behavior: "domain", Location: "remote", URL: fmt.Sprintf("https://example.org/%d.yaml", i), UpdatePolicy: "follow", IntervalSeconds: 3600})
	}
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	large, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatal("supported resource count failed rendering", err)
	}
	if large.Semantics.Groups.State != "available" || large.Semantics.Nodes.State != "available" || !strings.Contains(large.Artifacts[0].Content, "provider-32") {
		t.Fatal("optional inspection changed emitted publication")
	}
	if _, err := render.InspectFullConfigSecrets(target, large.Artifacts, large.NameAllocations); err == nil {
		t.Fatal("inherited 32-key inspection budget was not enforced")
	}
	p = clientProfile()
	for i := 0; i < 20; i++ {
		p.Rules[0].Match = domain.MatchExpression{Op: "and", Children: []domain.MatchExpression{p.Rules[0].Match}}
	}
	target = render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}
	deep, err := render.DefaultClients().Render(p, target, render.FullConfig)
	if err != nil {
		t.Fatal("supported nested rule failed rendering", err)
	}
	if deep.Semantics == nil || len(deep.Artifacts) != 1 {
		t.Fatal("render lost deliverable")
	}
	if _, err := render.InspectFullConfigSecrets(target, deep.Artifacts, deep.NameAllocations); err == nil {
		t.Fatal("inherited depth inspection budget was not enforced")
	}
}
