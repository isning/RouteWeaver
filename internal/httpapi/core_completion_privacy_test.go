package httpapi

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"strings"
	"testing"
)

func TestHysteria2ObfuscationCredentialRedaction(t *testing.T) {
	c := domain.Connection{Protocol: "hysteria2", Host: "proxy.example", Port: 443, Password: "synthetic-main", Hysteria2: &domain.Hysteria2Options{Obfs: &domain.ObfuscationOptions{Type: "salamander", Password: "synthetic-obfs"}}}
	endpoint := domain.ClientEndpoint{Connection: c}
	out := redactEndpoint(endpoint)
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "synthetic-") {
		t.Fatal("endpoint summary exposed credentials")
	}
	if c.Hysteria2.Obfs.Password != "synthetic-obfs" {
		t.Fatal("redaction mutated saved credentials")
	}
	for _, text := range []string{`{"obfs-password":"synthetic-obfs"}`, `{"hysteria2":{"obfs":{"password":"synthetic-obfs"}}}`} {
		if strings.Contains(redactArtifact(text), "synthetic-obfs") {
			t.Fatal("native preview exposed obfuscation password")
		}
	}
	redact := sourceLabelRedactor(&domain.SourceSnapshot{Endpoints: []domain.ClientEndpoint{endpoint}})
	if strings.Contains(redact("node synthetic-obfs"), "synthetic-obfs") {
		t.Fatal("label exposed credential")
	}
}
