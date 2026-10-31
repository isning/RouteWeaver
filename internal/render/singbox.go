package render

import (
	"encoding/json"
	"fmt"
	"routeweaver/internal/domain"
)

// SingBox preserves the legacy client-chain preview seam only.
type SingBox struct{}

func (SingBox) Capability() domain.Capability {
	return domain.Capability{ID: "sing-box", Name: "sing-box", Protocols: []string{"socks", "shadowsocks", "vless", "trojan", "vmess"}, MaxHops: 0}
}
func (SingBox) Render(r domain.Route, ns []domain.Node) ([]domain.Artifact, error) {
	if len(ns) == 0 {
		return nil, fmt.Errorf("empty route")
	}
	out := []any{}
	for i, n := range ns {
		if err := validateOutboundTarget(n.ConnectionValue(), "sing-box"); err != nil {
			return nil, err
		}
		o := singboxConnection(n.ConnectionValue(), "hop-"+n.ID)
		if i > 0 {
			o["detour"] = "hop-" + ns[i-1].ID
		}
		out = append(out, o)
	}
	config := map[string]any{"log": map[string]any{"level": "warn"}, "inbounds": []any{map[string]any{"type": "socks", "tag": "local", "listen": "127.0.0.1", "listen_port": 10808}}, "outbounds": out, "dns": map[string]any{"servers": []any{map[string]any{"type": "local", "tag": "rw-system-dns"}}, "final": "rw-system-dns"}, "route": map[string]any{"final": "hop-" + ns[len(ns)-1].ID, "default_domain_resolver": "rw-system-dns"}}
	b, err := json.MarshalIndent(config, "", "  ")
	return []domain.Artifact{{Path: "sing-box.json", Content: string(b)}}, err
}
