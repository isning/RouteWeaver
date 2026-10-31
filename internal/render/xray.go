package render

import (
	"encoding/json"
	"fmt"
	"routeweaver/internal/domain"
)

// Xray is a compatibility renderer for old client-chain previews. It is not a
// server deployment renderer; new callers should use a scoped registry.
type Xray struct{}

func (Xray) Capability() domain.Capability {
	return domain.Capability{ID: "xray", Name: "Xray", Protocols: []string{"socks", "shadowsocks", "vless", "trojan", "vmess"}, MaxHops: 0}
}
func (Xray) Render(r domain.Route, ns []domain.Node) ([]domain.Artifact, error) {
	if len(ns) == 0 {
		return nil, fmt.Errorf("empty route")
	}
	out := []any{}
	for i, n := range ns {
		if err := validateOutboundTarget(n.ConnectionValue(), "xray"); err != nil {
			return nil, err
		}
		o := xrayConnection(n.ConnectionValue(), "hop-"+n.ID)
		if i > 0 {
			stream, ok := o["streamSettings"].(map[string]any)
			if !ok {
				stream = map[string]any{}
				o["streamSettings"] = stream
			}
			stream["sockopt"] = map[string]any{"dialerProxy": "hop-" + ns[i-1].ID}
		}
		out = append(out, o)
	}
	config := map[string]any{"log": map[string]any{"loglevel": "warning"}, "inbounds": []any{map[string]any{"tag": "local", "listen": "127.0.0.1", "port": 10808, "protocol": "socks", "settings": map[string]any{"auth": "noauth", "udp": false}}}, "outbounds": out, "routing": map[string]any{"rules": []any{map[string]any{"type": "field", "inboundTag": []string{"local"}, "outboundTag": "hop-" + ns[len(ns)-1].ID}}}}
	b, err := json.MarshalIndent(config, "", "  ")
	return []domain.Artifact{{Path: "xray.json", Content: string(b)}}, err
}
