package render_test

import (
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

func TestStockSecurityVersionsPreserveHistoricalAndIndependentTargets(t *testing.T) {
	for _, tc := range []struct {
		adapter  render.ServerRenderer
		versions []string
	}{
		{render.XrayServer{}, []string{"26.10.31", "26.10.29", "26.3.27"}},
		{render.SingBoxServer{}, []string{"1.14.4", "1.14.3"}},
	} {
		capability := tc.adapter.ServerCapability()
		t.Run(capability.AdapterID, func(t *testing.T) {
			if !reflect.DeepEqual(capability.Versions, tc.versions) {
				t.Fatalf("stock versions must prefer current release and preserve historic identity: %v", capability.Versions)
			}
			protocols := []string{"socks", "shadowsocks", "vless", "trojan", "vmess"}
			if capability.AdapterID == render.ServerAdapterSingBox {
				protocols = append(protocols, "hysteria2")
			}
			if !reflect.DeepEqual(capability.Protocols, protocols) {
				t.Fatalf("stock update changed protocol capabilities: %v", capability.Protocols)
			}
			for _, version := range tc.versions {
				if _, err := render.DefaultServers().Render(serverIR(capability.AdapterID, version)); err != nil {
					t.Fatalf("reviewed stock target %s failed rendering: %v", version, err)
				}
			}
			if _, err := render.DefaultServers().Render(serverIR(capability.AdapterID, "unreviewed")); err == nil || !strings.Contains(err.Error(), "SERVER_VERSION_UNVERIFIED") {
				t.Fatalf("unknown stock version inherited support: %v", err)
			}
		})
	}

	client := (render.SingBoxClient{}).ClientCapability()
	if !reflect.DeepEqual(client.Versions, []string{"1.14.3"}) {
		t.Fatalf("stock release update relabeled the client/schema contract: %v", client.Versions)
	}
	if _, err := render.DefaultClients().Render(domain.ClientProfileIR{}, render.Target{AdapterID: "sing-box", Version: "1.14.4"}, render.FullConfig); err == nil || !strings.Contains(err.Error(), "TARGET_VERSION_UNVERIFIED") {
		t.Fatalf("stock version inherited client compatibility: %v", err)
	}
	p := principalProgram(render.ServerAdapterManagedXray, "26.3.27-rw1")
	artifacts, err := render.DefaultServers().Render(domain.ServerDeploymentIR{SchemaVersion: "1.0", ID: "managed", TopologyRevision: "r1", Programs: []domain.ServerProgram{p}})
	if err != nil {
		t.Fatal(err)
	}
	var descriptor struct{ CoreVersion, RuntimeVersion string }
	if err = json.Unmarshal([]byte(artifacts[1].Content), &descriptor); err != nil {
		t.Fatal(err)
	}
	if descriptor.CoreVersion != "26.3.27" || descriptor.RuntimeVersion != "26.3.27-rw1" {
		t.Fatalf("stock update relabeled managed executable: %+v", descriptor)
	}
}
