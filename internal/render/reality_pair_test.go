package render_test

import (
	"crypto/ecdh"
	"encoding/base64"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"testing"
)

func TestServerRealityClientParametersMatchServerMaterial(t *testing.T) {
	for _, target := range []struct{ adapter, version string }{{render.ServerAdapterXray, render.XrayVersion}, {render.ServerAdapterSingBox, render.SingBoxVersion}} {
		t.Run(target.adapter, func(t *testing.T) {
			raw := make([]byte, 32)
			for i := range raw {
				raw[i] = byte(i)
			}
			key, err := ecdh.X25519().NewPrivateKey(raw)
			if err != nil {
				t.Fatal(err)
			}
			cases := []struct {
				name   string
				change func(*domain.ServerProgram)
				valid  bool
			}{
				{"matching", func(p *domain.ServerProgram) {}, true},
				{"empty short ID", func(p *domain.ServerProgram) {
					p.Listener.Connection.TLS.Reality.ShortID = ""
					p.TLS.Reality.ShortIDs = []string{""}
				}, true},
				{"wildcard does not authorize concrete SNI", func(p *domain.ServerProgram) { p.TLS.Reality.ServerNames = []string{"*.com"} }, false},
				{"client REALITY with certificate server", func(p *domain.ServerProgram) {
					p.TLS = &domain.ServerTLSOptions{CertificatePath: "tls/cert.pem", KeyPath: "tls/key.pem"}
				}, false},
				{"short ID hexadecimal case and padding", func(p *domain.ServerProgram) { p.Listener.Connection.TLS.Reality.ShortID = "AB00" }, true},
				{"missing client reality", func(p *domain.ServerProgram) { p.Listener.Connection.TLS.Reality = nil }, false},
				{"wrong public key", func(p *domain.ServerProgram) {
					p.Listener.Connection.TLS.Reality.PublicKey = base64.RawURLEncoding.EncodeToString(make([]byte, 32))
				}, false},
				{"wrong short ID", func(p *domain.ServerProgram) { p.Listener.Connection.TLS.Reality.ShortID = "ac" }, false},
				{"wrong server name", func(p *domain.ServerProgram) { p.Listener.Connection.TLS.ServerName = "other.example.com" }, false},
			}
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					ir := serverIR(target.adapter, target.version)
					p := &ir.Programs[0]
					p.Listener.Connection = domain.Connection{Host: "127.0.0.1", Port: 18443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", TLS: &domain.TLSOptions{Enabled: true, ServerName: "example.com", Fingerprint: "chrome", Reality: &domain.RealityOptions{PublicKey: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), ShortID: "ab"}}}
					p.TLS = &domain.ServerTLSOptions{Reality: &domain.ServerRealityOptions{PrivateKey: base64.RawURLEncoding.EncodeToString(raw), HandshakeServer: "example.com", HandshakePort: 443, ServerNames: []string{"example.com"}, ShortIDs: []string{"ab"}}}
					tc.change(p)
					_, err := render.DefaultServers().Render(ir)
					if (err == nil) != tc.valid {
						t.Fatalf("valid=%v, got error %v", tc.valid, err)
					}
				})
			}
		})
	}
}
