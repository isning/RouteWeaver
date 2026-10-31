package render_test

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"testing"
)

func TestTwoHopArtifacts(t *testing.T) {
	ns := []domain.Node{{ID: "a", Name: "Entry", Host: "entry.example", Port: 1080, Protocol: "socks"}, {ID: "b", Name: "Exit", Host: "exit.example", Port: 1080, Protocol: "socks"}}
	r := domain.Route{ID: "r", Name: "Chain", Hops: []string{"a", "b"}}
	for _, id := range []string{"xray", "sing-box"} {
		r.Engine = id
		a, e := render.Default().Render(r, ns)
		if e != nil {
			t.Fatal(e)
		}
		var config map[string]any
		if e = json.Unmarshal([]byte(a[0].Content), &config); e != nil {
			t.Fatal(e)
		}
		outs := config["outbounds"].([]any)
		last := outs[1].(map[string]any)
		if id == "sing-box" && last["detour"] != "hop-a" {
			t.Fatal("exit must dial through entry")
		}
		if id == "xray" && last["streamSettings"].(map[string]any)["sockopt"].(map[string]any)["dialerProxy"] != "hop-a" {
			t.Fatal("exit must dial through entry")
		}
	}
}

func TestLegacyAdapterDoesNotImposeTwoHopLimit(t *testing.T) {
	nodes := []domain.Node{{ID: "a", Name: "A", Host: "192.0.2.1", Port: 1080, Protocol: "socks"}, {ID: "b", Name: "B", Host: "192.0.2.2", Port: 1080, Protocol: "socks"}, {ID: "c", Name: "C", Host: "192.0.2.3", Port: 1080, Protocol: "socks"}}
	for _, engine := range []string{"xray", "sing-box"} {
		if _, err := render.Default().Render(domain.Route{ID: "r", Name: "Three", Engine: engine, Hops: []string{"a", "b", "c"}}, nodes); err != nil {
			t.Fatalf("%s: %v", engine, err)
		}
	}
}
