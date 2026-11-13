package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOIDCStartupConfigurationFailsClosed(t *testing.T) {
	if p, e := configuredOIDC("", ""); p != nil || e != nil {
		t.Fatal("optional OIDC changed local login")
	}
	for _, tc := range []struct {
		name, body, origin string
		mode               os.FileMode
	}{
		{"readable-secret", `{}`, "https://routeweaver.example", 0644},
		{"unknown-field", `{"unknown":true}`, "https://routeweaver.example", 0600},
		{"trailing-json", `{} {}`, "https://routeweaver.example", 0600},
		{"missing-origin", `{"issuer":"https://idp.example","clientId":"fixture","clientSecret":"synthetic","bindings":[{"subject":"sub","accountId":"account"}]}`, "", 0600},
		{"insecure-issuer", `{"issuer":"http://idp.example","clientId":"fixture","clientSecret":"synthetic","bindings":[{"subject":"sub","accountId":"account"}]}`, "https://routeweaver.example", 0600},
		{"duplicate-subject", `{"issuer":"https://idp.example","clientId":"fixture","clientSecret":"synthetic","bindings":[{"subject":"sub","accountId":"a"},{"subject":"sub","accountId":"b"}]}`, "https://routeweaver.example", 0600},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "oidc.json")
			if e := os.WriteFile(path, []byte(tc.body), tc.mode); e != nil {
				t.Fatal(e)
			}
			if p, e := configuredOIDC(path, tc.origin); p != nil || e == nil {
				t.Fatal("invalid configured OIDC silently accepted")
			}
		})
	}
}
