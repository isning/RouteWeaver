package render

import (
	"fmt"
	"routeweaver/internal/domain"
	"strings"
)

// validateOutboundTarget is shared by legacy chain previews and scoped adapters.
// Target restrictions must fail before native emission, never omit user intent.
func validateOutboundTarget(c domain.Connection, target string) error {
	if err := domain.ValidateConnection(c); err != nil {
		return err
	}
	switch target {
	case "xray":
		if !has((Xray{}).Capability().Protocols, c.Protocol) {
			return fmt.Errorf("PROTOCOL_UNSUPPORTED: selected Xray target")
		}
		if c.PacketEncoding != "" {
			return fmt.Errorf("XRAY_PACKET_ENCODING_UNVERIFIED: explicit packet encoding cannot be omitted")
		}
		return validateXraySecurity(c)
	case "sing-box":
		return validateClientConnection(c, (SingBoxClient{}).ClientCapability())
	case "mihomo":
		return validateClientConnection(c, (MihomoClient{}).ClientCapability())
	}
	return fmt.Errorf("TARGET_UNSUPPORTED: outbound target not registered")
}

func validateClientConnection(c domain.Connection, capability ClientCapability) error {
	if err := domain.ValidateConnection(c); err != nil {
		return err
	}
	if c.Transport != nil && c.Transport.Authority != "" {
		return fmt.Errorf("GRPC_AUTHORITY_UNSUPPORTED: selected client target cannot preserve authority")
	}
	if !has(capability.Protocols, c.Protocol) {
		return fmt.Errorf("PROTOCOL_UNSUPPORTED: selected client target")
	}
	if c.TLS != nil && c.TLS.Fingerprint != "" && !has(capability.TLSFingerprints, strings.ToLower(c.TLS.Fingerprint)) {
		return fmt.Errorf("TLS_FINGERPRINT_UNSUPPORTED: selected client target")
	}
	return nil
}

// REALITY uses its own native settings, not ordinary TLS settings. This guard
// also applies to listeners; SNI/fingerprint remain published-client hints.
func validateXraySecurity(c domain.Connection) error {
	if c.TLS == nil || c.TLS.Reality == nil {
		return nil
	}
	if len(c.TLS.ALPN) > 0 {
		return fmt.Errorf("XRAY_REALITY_ALPN_UNSUPPORTED: cannot preserve explicit ALPN")
	}
	if c.Transport != nil && c.Transport.Type != "tcp" && c.Transport.Type != "grpc" {
		return fmt.Errorf("XRAY_REALITY_TRANSPORT_UNSUPPORTED: use TCP or gRPC with REALITY")
	}
	return nil
}
