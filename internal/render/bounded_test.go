package render_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestBoundedRenderPreservesExplicitResult(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		p := clientProfile()
		ordinary, err := render.DefaultClients().Render(p, target, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		bounded, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(ordinary, bounded) {
			t.Fatal("bounded render changed result")
		}
	}
}
func TestBoundedRenderRejectsLargeInputWithoutChangingExplicitRender(t *testing.T) {
	p := clientProfile()
	p.Name = strings.Repeat("private-value", 400)
	before, _ := json.Marshal(p)
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	_, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig)
	after, _ := json.Marshal(p)
	if string(before) != string(after) {
		t.Fatal("rejected rendering changed input")
	}
	var limit *render.RenderBudgetError
	if !errors.As(err, &limit) || strings.Contains(err.Error(), "private-value") {
		t.Fatalf("expected private budget error: %v", err)
	}
	if _, err := render.DefaultClients().Render(p, target, render.FullConfig); err != nil {
		t.Fatal(err)
	}
}

func TestBoundedNativeUsesFinalArtifactAndLeavesInputUntouched(t *testing.T) {
	for _, tc := range []struct {
		target  render.Target
		content string
	}{
		{render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, `{"log-level":"debug"}`},
		{render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, `{"log":{"level":"debug"}}`},
	} {
		p := withNative(t, clientProfile(), tc.target, "json", tc.content, "prepend")
		before, _ := json.Marshal(p)
		ordinary, err := render.DefaultClients().Render(p, tc.target, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		bounded, err := render.DefaultClients().RenderBounded(p, tc.target, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(ordinary, bounded) {
			t.Fatal("native artifact differs")
		}
		after, _ := json.Marshal(p)
		if string(before) != string(after) {
			t.Fatal("render changed input")
		}
	}
}

func TestBoundedNativeDeclinesUnsafeParsing(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	for _, tc := range []struct{ name, format, content string }{
		{"size", "json", `{"log-level":"debug"}` + strings.Repeat(" ", 4096)},
		{"depth", "json", `{"x":` + strings.Repeat("[", 8) + `0` + strings.Repeat("]", 8) + `}`},
		{"tokens", "json", `{"x":[` + strings.Repeat("0,", 256) + `0]}`},
		{"trailing", "json", `{} {}`},
		{"invalid", "json", `{"x":`},
		{"scalar", "json", `null`},
		{"yaml", "yaml", "log-level: debug"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := withNative(t, clientProfile(), target, tc.format, tc.content, "prepend")
			_, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig)
			var limit *render.RenderBudgetError
			if !errors.As(err, &limit) {
				t.Fatalf("expected budget error: %v", err)
			}
		})
	}
	// Explicit editing retains YAML support, separate from automatic admission.
	p := withNative(t, clientProfile(), target, "yaml", "log-level: debug", "prepend")
	if _, err := render.DefaultClients().Render(p, target, render.FullConfig); err != nil {
		t.Fatal(err)
	}
}

func TestBoundedNativeKeepsRendererSchemaAndDuplicateKeyValidation(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	for _, content := range []string{`{"log-level":"not-a-level"}`, `{"log-level":"debug","log-level":"info"}`} {
		p := withNative(t, clientProfile(), target, "json", content, "prepend")
		if _, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig); err == nil {
			t.Fatal("accepted invalid native configuration")
		}
	}
}

func TestBoundedRenderChecksGeneratedExpansion(t *testing.T) {
	p := clientProfile()
	first := p.Groups[0]
	endpoint := p.Endpoints[0]
	p.Endpoints = nil
	first.Members = nil
	for i := 0; i < 14; i++ {
		e := endpoint
		e.ID = fmt.Sprintf("e%d", i)
		e.Name = fmt.Sprintf("%02d", i) + strings.Repeat("a", 148)
		p.Endpoints = append(p.Endpoints, e)
		first.Members = append(first.Members, domain.ActionRef{Kind: "endpoint", Ref: e.ID})
	}
	p.Groups = nil
	for i := 0; i < 8; i++ {
		g := first
		g.ID = fmt.Sprintf("g%d", i)
		g.Name = g.ID
		p.Groups = append(p.Groups, g)
	}
	p.Rules = nil
	p.DefaultAction = domain.ActionRef{Kind: "direct"}
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	_, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig)
	var limit *render.RenderBudgetError
	if !errors.As(err, &limit) || limit.Stage != "generated-base" {
		t.Fatalf("expected generated expansion limit: %v", err)
	}
	if _, err := render.DefaultClients().Render(p, target, render.FullConfig); err != nil {
		t.Fatal(err)
	}
}

func TestBoundedRenderInputAndNativeByteEdges(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	for _, size := range []int{4096, 4097} {
		p := clientProfile()
		p.Name = strings.Repeat("x", size)
		_, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig)
		if (err == nil) != (size == 4096) {
			t.Fatalf("input size %d: %v", size, err)
		}
		patch := `{"log-level":"debug"}`
		p = withNative(t, clientProfile(), target, "json", patch+strings.Repeat(" ", size-len(patch)), "prepend")
		_, err = render.DefaultClients().RenderBounded(p, target, render.FullConfig)
		if (err == nil) != (size == 4096) {
			t.Fatalf("native size %d: %v", size, err)
		}
	}
}

func TestBoundedRenderLimitsNestedIRBeforeValidation(t *testing.T) {
	p := clientProfile()
	m := p.Rules[0].Match
	for i := 0; i < 20; i++ {
		m = domain.MatchExpression{Op: "not", Children: []domain.MatchExpression{m}}
	}
	p.Rules[0].Match = m
	_, err := render.DefaultClients().RenderBounded(p, render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, render.FullConfig)
	var limit *render.RenderBudgetError
	if !errors.As(err, &limit) || limit.Stage != "input" {
		t.Fatalf("expected input depth error: %v", err)
	}
}

func TestBoundedRenderChecksMergedSchemaInput(t *testing.T) {
	p := boundedExpansionProfile()
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	if _, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig); err != nil {
		t.Fatalf("small base: %v", err)
	}
	p = withNative(t, p, target, "json", `{"dns":{"nameserver":["https://`+strings.Repeat("a", 3000)+`.example/dns-query"]}}`, "prepend")
	_, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig)
	var limit *render.RenderBudgetError
	if !errors.As(err, &limit) || limit.Stage != "merged-schema" {
		t.Fatalf("expected merged tree limit: %v", err)
	}
}

func TestBoundedNativeTokenAndDepthEdges(t *testing.T) {
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	for _, tc := range []struct {
		name, content string
		limited       bool
	}{
		{"256-tokens", `{"x":[` + strings.Repeat("0,", 250) + `0]}`, false},
		{"257-tokens", `{"x":[` + strings.Repeat("0,", 251) + `0]}`, true},
		{"8-levels", `{"x":` + strings.Repeat("[", 7) + `0` + strings.Repeat("]", 7) + `}`, false},
		{"9-levels", `{"x":` + strings.Repeat("[", 8) + `0` + strings.Repeat("]", 8) + `}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := withNative(t, clientProfile(), target, "json", tc.content, "prepend")
			_, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig)
			if err == nil {
				t.Fatal("unknown native field must still fail semantic validation")
			}
			var limit *render.RenderBudgetError
			if errors.As(err, &limit) != tc.limited {
				t.Fatalf("wrong admission boundary: %v", err)
			}
		})
	}
}

type unreviewedBoundedAdapter struct{ render.MihomoClient }

func TestBoundedRenderDoesNotTrustRegisteredAdapterIdentityAlone(t *testing.T) {
	registry := render.NewClients(unreviewedBoundedAdapter{})
	_, err := registry.RenderBounded(clientProfile(), render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, render.FullConfig)
	var limit *render.RenderBudgetError
	if !errors.As(err, &limit) || limit.Stage != "adapter" {
		t.Fatalf("unreviewed adapter admitted: %v", err)
	}
}

func boundedExpansionProfile() domain.ClientProfileIR {
	p := clientProfile()
	first := p.Groups[0]
	endpoint := p.Endpoints[0]
	p.Endpoints = nil
	first.Members = nil
	for i := 0; i < 10; i++ {
		e := endpoint
		e.ID = fmt.Sprintf("e%d", i)
		e.Name = fmt.Sprintf("%02d", i) + strings.Repeat("a", 148)
		p.Endpoints = append(p.Endpoints, e)
		first.Members = append(first.Members, domain.ActionRef{Kind: "endpoint", Ref: e.ID})
	}
	p.Groups = nil
	for i := 0; i < 8; i++ {
		g := first
		g.ID = fmt.Sprintf("g%d", i)
		g.Name = g.ID
		p.Groups = append(p.Groups, g)
	}
	p.Rules = nil
	p.DefaultAction = domain.ActionRef{Kind: "direct"}

	return p
}

func TestBoundedRenderChecksComposedBaseBeforeMerge(t *testing.T) {
	p := boundedExpansionProfile()
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	names := []string{}
	for _, endpoint := range p.Endpoints {
		names = append(names, endpoint.Name)
	}
	content, _ := json.Marshal(map[string]any{"proxy-groups": []any{
		map[string]any{"name": "native-a", "type": "select", "proxies": names},
		map[string]any{"name": "native-b", "type": "select", "proxies": names},
	}})
	p = withNative(t, p, target, "json", string(content), "prepend")
	_, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig)
	var limit *render.RenderBudgetError
	if !errors.As(err, &limit) || limit.Stage != "composed-base" {
		t.Fatalf("expected composed base budget: %v", err)
	}
}

// Near the raw-token ceiling, exercise the real embedded schemas and native
// composition rather than a mocked validator. This is evidence, not a deadline.
func boundedSchemaEdge(target render.Target) string {
	if target.AdapterID == "mihomo" {
		return `{"rules":[` + strings.Repeat(`"UID,1,DIRECT",`, 249) + `"UID,1,DIRECT"]}`
	}
	rule := `{"domain":["example.com"],"outbound":"rw-direct"}`
	return `{"route":{"rules":[` + strings.Repeat(rule+",", 30) + rule + `]}}`
}
func TestBoundedNativeSchemaNearTokenCeiling(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		p := withNative(t, clientProfile(), target, "json", boundedSchemaEdge(target), "prepend")
		expected, err := render.DefaultClients().Render(p, target, render.FullConfig)
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 20; i++ {
			got, err := render.DefaultClients().RenderBounded(p, target, render.FullConfig)
			if err != nil {
				t.Fatalf("%s iteration %d: %v", target.AdapterID, i, err)
			}
			if !reflect.DeepEqual(got, expected) {
				t.Fatal("near-limit rendering changed result")
			}
		}
	}
}
func BenchmarkBoundedNativeSchema(b *testing.B) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		b.Run(target.AdapterID, func(b *testing.B) {
			p := clientProfile()
			p.NativeOverride = &domain.NativeClientOverride{SchemaVersion: "1", Namespace: "routeweaver/native-client", Target: domain.NativeClientTarget{AdapterID: target.AdapterID, Version: target.Version}, Format: "json", Content: boundedSchemaEdge(target), RuleMode: "prepend"}
			registry := render.DefaultClients()
			if _, err := registry.RenderBounded(p, target, render.FullConfig); err != nil {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := registry.RenderBounded(p, target, render.FullConfig); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func TestBoundedNodesOnlyPreservesExplicitSemantics(t *testing.T) {
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		p := clientProfile()
		before, _ := json.Marshal(p)
		expected, err := render.DefaultClients().Render(p, target, render.NodesOnly)
		if err != nil {
			t.Fatal(err)
		}
		got, err := render.DefaultClients().RenderBounded(p, target, render.NodesOnly)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, expected) {
			t.Fatal("nodes-only result changed")
		}
		after, _ := json.Marshal(p)
		if string(before) != string(after) {
			t.Fatal("nodes-only render mutated input")
		}
	}
}
