package managedxray_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	managed "routeweaver/runtimes/xray"
)

func detourOutbound(tag, via, protocol string, port int) map[string]any {
	stream := map[string]any{"network": "tcp", "security": "none"}
	if via != "" {
		stream["sockopt"] = map[string]any{"dialerProxy": via}
	}
	settings := map[string]any{}
	switch protocol {
	case "vless":
		settings["vnext"] = []any{map[string]any{"address": "127.0.0.1", "port": port, "users": []any{map[string]any{"id": "00112233-4455-6677-8899-aabbccddeeff", "encryption": "none"}}}}
	case "socks":
		settings["servers"] = []any{map[string]any{"address": "127.0.0.1", "port": port}}
	case "shadowsocks":
		settings["servers"] = []any{map[string]any{"address": "127.0.0.1", "port": port, "method": "aes-128-gcm", "password": "loopback-fixture-only"}}
	}
	return map[string]any{"tag": tag, "protocol": protocol, "settings": settings, "streamSettings": stream}
}

func detourConfig(t *testing.T, port int, outbounds []any) []byte {
	t.Helper()
	var native map[string]any
	if err := json.Unmarshal(config(port), &native); err != nil {
		t.Fatal(err)
	}
	native["outbounds"] = outbounds
	encoded, err := json.Marshal(native)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestManagedAcceptsOnlyScopedAcyclicOutboundDetours(t *testing.T) {
	for _, protocol := range []string{"vless", "socks", "shadowsocks"} {
		t.Run(protocol, func(t *testing.T) {
			// Forward references and shared predecessors are valid. Native
			// construction must resolve the entire graph, not array order.
			outbounds := []any{
				detourOutbound("last", "middle", protocol, 21003),
				detourOutbound("sibling", "first", protocol, 21004),
				detourOutbound("middle", "first", protocol, 21002),
				detourOutbound("first", "", protocol, 21001),
				map[string]any{"tag": "direct", "protocol": "freedom"},
			}
			if err := managed.Validate(detourConfig(t, 22001, outbounds), descriptor()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestManagedRejectsAmbiguousOrUnsupportedDetourGraphs(t *testing.T) {
	baseline := []any{detourOutbound("last", "middle", "vless", 21003), detourOutbound("middle", "first", "vless", 21002), detourOutbound("first", "", "vless", 21001)}
	if err := managed.Validate(detourConfig(t, 22001, baseline), descriptor()); err != nil {
		t.Fatal("valid graph baseline rejected:", err)
	}
	for name, mutate := range map[string]func([]any){
		"missing target": func(o []any) {
			o[0].(map[string]any)["streamSettings"].(map[string]any)["sockopt"] = map[string]any{"dialerProxy": "missing"}
		},
		"self cycle": func(o []any) {
			o[0].(map[string]any)["streamSettings"].(map[string]any)["sockopt"] = map[string]any{"dialerProxy": "last"}
		},
		"two edge cycle": func(o []any) {
			o[1].(map[string]any)["streamSettings"].(map[string]any)["sockopt"] = map[string]any{"dialerProxy": "last"}
		},
		"longer cycle": func(o []any) {
			o[2].(map[string]any)["streamSettings"].(map[string]any)["sockopt"] = map[string]any{"dialerProxy": "last"}
		},
		"duplicate tag": func(o []any) {
			o[2].(map[string]any)["tag"] = "middle"
		},
		"untagged source": func(o []any) {
			delete(o[0].(map[string]any), "tag")
		},
		"invalid tag": func(o []any) {
			o[2].(map[string]any)["tag"] = "bad tag"
		},
		"alternate proxy edge": func(o []any) {
			o[2].(map[string]any)["proxySettings"] = map[string]any{"tag": "last"}
		},
		"conflicting proxy edge": func(o []any) {
			o[0].(map[string]any)["proxySettings"] = map[string]any{"tag": "first"}
		},
		"non-proxy source": func(o []any) {
			o[0].(map[string]any)["protocol"] = "freedom"
		},
		"non-proxy target": func(o []any) {
			o[2].(map[string]any)["protocol"] = "blackhole"
		},
		"Vision": func(o []any) {
			o[0].(map[string]any)["settings"].(map[string]any)["vnext"].([]any)[0].(map[string]any)["users"].([]any)[0].(map[string]any)["flow"] = "xtls-rprx-vision"
		},
		"unsupported transport": func(o []any) {
			o[0].(map[string]any)["streamSettings"].(map[string]any)["network"] = "ws"
		},
		"unsupported security": func(o []any) {
			o[0].(map[string]any)["streamSettings"].(map[string]any)["security"] = "reality"
		},
		"transport mask": func(o []any) {
			o[0].(map[string]any)["streamSettings"].(map[string]any)["finalmask"] = map[string]any{}
		},
	} {
		t.Run(name, func(t *testing.T) {
			outbounds := []any{detourOutbound("last", "middle", "vless", 21003), detourOutbound("middle", "first", "vless", 21002), detourOutbound("first", "", "vless", 21001)}
			mutate(outbounds)
			if err := managed.Validate(detourConfig(t, 22001, outbounds), descriptor()); err == nil {
				t.Fatal("unsafe detour accepted")
			}
		})
	}
}

func TestManagedDetourSocketOptionsFailClosed(t *testing.T) {
	outbounds := []any{detourOutbound("last", "first", "vless", 21002), detourOutbound("first", "", "vless", 21001)}
	baseline := string(detourConfig(t, 22001, outbounds))
	if err := managed.Validate([]byte(baseline), descriptor()); err != nil {
		t.Fatal("valid socket baseline rejected:", err)
	}
	for _, sockopt := range []string{
		`null`, `{}`, `[]`, `"first"`,
		`{"dialerProxy":""}`, `{"dialerProxy":null}`, `{"dialerProxy":1}`,
		`{"dialerProxy":"bad tag"}`, `{"DialerProxy":"first"}`,
		`{"dialerProxy":"first","tcpMptcp":true}`,
		`{"dialerProxy":"first","acceptProxyProtocol":true}`,
		`{"dialerProxy":"first","addressPortStrategy":"ForceIP"}`,
		`{"dialerProxy":"missing","dialerProxy":"first"}`,
		`{"dialerProxy":"first"},"sockopt":{"dialerProxy":"first"}`,
		`{"tcpMptcp":true},"sockopt":{"dialerProxy":"first"}`,
	} {
		t.Run(sockopt, func(t *testing.T) {
			native := strings.Replace(baseline, `"sockopt":{"dialerProxy":"first"}`, `"sockopt":`+sockopt, 1)
			if err := managed.Validate([]byte(native), descriptor()); err == nil {
				t.Fatal("unsupported or ambiguous socket options accepted")
			}
		})
	}
	for _, first := range []string{`{"tcpMptcp":true}`, `{"dialerProxy":"first"}`} {
		t.Run("merged stream/"+first, func(t *testing.T) {
			native := strings.Replace(baseline, `"streamSettings":{"network":"tcp","security":"none","sockopt":{"dialerProxy":"first"}}`, `"streamSettings":{"sockopt":`+first+`},"streamSettings":{"sockopt":{"dialerProxy":"first"}}`, 1)
			if native == baseline {
				t.Fatal("duplicate-stream fixture did not mutate the baseline")
			}
			if err := managed.Validate([]byte(native), descriptor()); err == nil {
				t.Fatal("merged stream socket options accepted")
			}
		})
	}
	for _, sockopt := range []string{`{"dialerProxy":"first"}`, `{}`, `null`} {
		t.Run(fmt.Sprintf("ingress/%s", sockopt), func(t *testing.T) {
			native := strings.Replace(string(config(22001)), `"streamSettings":{`, `"streamSettings":{"sockopt":`+sockopt+`,`, 1)
			if err := managed.Validate([]byte(native), descriptor()); err == nil {
				t.Fatal("ingress socket options accepted")
			}
		})
	}
}
