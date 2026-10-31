package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
)

// Only these fixed synthetic fixtures are passed to native binaries. Production
// override validation never invokes a native process or opens its referenced paths.
// Successful parser checks are not process liveness, routing, or device-TUN proof.
func TestNativeOverridePublishedArtifactsPassPinnedNativeParsers(t *testing.T) {
	cases := []struct {
		target       render.Target
		env, content string
	}{
		{render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}, "ROUTEWEAVER_MIHOMO_BIN", `{"dns":{"enable":true,"enhanced-mode":"fake-ip","fake-ip-range":"198.18.0.1/16","nameserver":["https://1.1.1.1/dns-query#Native%20apps"],"proxy-server-nameserver":["1.1.1.1"]},"proxy-groups":[{"name":"Native apps","type":"select","proxies":["Private node","DIRECT"]}],"rules":["PROCESS-NAME,curl,Native apps","DST-PORT,8443,REJECT"]}`},
		{render.Target{AdapterID: "sing-box", Version: render.SingBoxVersion}, "ROUTEWEAVER_SINGBOX_BIN", `{"dns":{"strategy":"prefer_ipv4","cache_capacity":1024},"outbounds":[{"type":"selector","tag":"Native apps","outbounds":["Private node","rw-direct"],"interrupt_exist_connections":true}],"route":{"rules":[{"process_name":["curl"],"action":"route","outbound":"Native apps"},{"port":[8443],"action":"reject"}]}}`},
	}
	for _, tt := range cases {
		t.Run(tt.target.AdapterID, func(t *testing.T) {
			binary := os.Getenv(tt.env)
			if binary == "" {
				t.Skip("native validator not requested: " + tt.env + " is unset")
			}
			args := []string{"-v"}
			if tt.target.AdapterID == "sing-box" {
				args = []string{"version"}
			}
			version, err := exec.Command(binary, args...).CombinedOutput()
			if err != nil || !strings.Contains(string(version), tt.target.Version) {
				t.Fatalf("native version mismatch: %v %s", err, version)
			}
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "native-parser-user")
			p := nativeProfile(tt.target, tt.content)
			code, _, raw := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatal(raw)
			}
			code, _, raw = req(t, u.c, "GET", srv.URL+"/api/me/profiles/native-profile/reveal", "", nil)
			if code != 200 {
				t.Fatal(raw)
			}
			var saved httpapi.Profile
			if json.Unmarshal([]byte(raw), &saved) != nil {
				t.Fatal("invalid saved profile")
			}
			result, err := render.DefaultClients().Render(saved.IR, saved.Target, saved.Mode)
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			path := filepath.Join(dir, result.Artifacts[0].Path)
			if err = os.WriteFile(path, []byte(result.Artifacts[0].Content), 0600); err != nil {
				t.Fatal(err)
			}
			args = []string{"-t", "-d", dir, "-f", path}
			if tt.target.AdapterID == "sing-box" {
				args = []string{"check", "-c", path}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, binary, args...)
			command.Dir = dir
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("fixed native override fixture rejected: %v\n%s", err, output)
			}
			code, out, raw := req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "native-output", "name": "Native accepted output", "profileId": p.ID})
			if code != 201 {
				t.Fatal(raw)
			}
			code, _, feed := req(t, http.DefaultClient, "GET", srv.URL+out["feedPath"].(string), "", nil)
			if code != 200 || feed != result.Artifacts[0].Content {
				t.Fatal("published bytes differ from native-checked saved profile")
			}
			t.Logf("%s %s: saved native process policy, native selector group and DNS settings accepted; published bytes exactly match parser input", tt.target.AdapterID, tt.target.Version)
		})
	}
}
