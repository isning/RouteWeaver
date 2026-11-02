package render

import (
	"encoding/json"
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
)

const ServerAdapterManagedXray = "routeweaver/managed-xray"
const ManagedXrayVersion = "26.3.27-rw1"

// ManagedXrayCoreVersion identifies the embedded module, not the stock catalog.
const ManagedXrayCoreVersion = "26.3.27"

// ServerArtifactRenderer is optional so a future managed adapter can add private
// runtime policy without teaching the registry about a particular core family.
type ServerArtifactRenderer interface {
	ServerArtifacts(domain.ServerProgram) ([]domain.Artifact, error)
}

type ManagedXrayServer struct{ restrictionOnly bool }

func (ManagedXrayServer) ServerCapability() ServerCapability {
	return ServerCapability{AdapterID: ServerAdapterManagedXray, Versions: []string{ManagedXrayVersion}, Protocols: []string{"vless"}, EgressProtocols: []string{"socks", "shadowsocks", "vless"}, MultiPrincipalProtocols: []string{"vless"}, ManagedAccess: true}
}
func (m ManagedXrayServer) RenderServer(p domain.ServerProgram) (any, error) {
	if len(p.Principals) > 1000 {
		return nil, fmt.Errorf("invalid managed binding count")
	}
	if err := domain.ValidateListenerTransport(p.Listener.Connection); err != nil {
		return nil, err
	}
	c := p.Listener.Connection
	if len(p.Principals) == 0 || c.Protocol != "vless" {
		return nil, fmt.Errorf("MANAGED_PRINCIPALS_REQUIRED: authenticated VLESS principals required")
	}
	if c.Transport != nil && c.Transport.Type != "tcp" || c.TLS != nil && c.TLS.Reality != nil || p.TLS != nil && p.TLS.Reality != nil || c.PacketEncoding != "" {
		return nil, fmt.Errorf("MANAGED_TRANSPORT_UNVERIFIED: only VLESS TCP with none or TLS security is verified")
	}
	connections := append([]domain.Connection(nil), p.Egress...)
	for _, connector := range p.Connectors {
		connections = append(connections, connector.Connection)
	}
	for _, connection := range connections {
		if !has((ManagedXrayServer{}).ServerCapability().EgressProtocols, connection.Protocol) {
			return nil, fmt.Errorf("MANAGED_EGRESS_PROTOCOL_UNSUPPORTED: managed connectors support SOCKS, Shadowsocks and VLESS only")
		}
		if connection.Flow != "" || connection.TLS != nil && connection.TLS.Reality != nil || connection.Transport != nil && connection.Transport.Type != "tcp" || connection.PacketEncoding != "" {
			return nil, fmt.Errorf("MANAGED_EGRESS_UNVERIFIED: managed connectors require TCP with empty flow, no packet wrapper, and none or TLS security")
		}
	}
	for _, principal := range p.Principals {
		if principal.Credential.Flow != "" {
			return nil, fmt.Errorf("MANAGED_FLOW_UNVERIFIED: Vision bypasses the measured payload seam")
		}
		if !domain.ValidID(principal.PolicyRevision) || !domain.ValidID(principal.CycleID) {
			return nil, fmt.Errorf("MANAGED_ACCOUNTING_IDENTITY_REQUIRED: policy revision and cycle identity required")
		}
	}
	if !m.restrictionOnly {
		if err := entrypolicy.ValidateTerminalCapacity(managedPrincipalBindings(p)); err != nil {
			return nil, err
		}
	}
	return (XrayServer{}).RenderServer(p)
}
func (m ManagedXrayServer) ServerArtifacts(p domain.ServerProgram) ([]domain.Artifact, error) {
	if len(p.Principals) > 1000 {
		return nil, fmt.Errorf("invalid managed binding count")
	}
	bindings := managedPrincipalBindings(p)
	if !m.restrictionOnly {
		if err := entrypolicy.ValidateTerminalCapacity(bindings); err != nil {
			return nil, err
		}
	}
	descriptor := entrypolicy.Descriptor{SchemaVersion: entrypolicy.SchemaVersion, AdapterID: ServerAdapterManagedXray, RuntimeVersion: ManagedXrayVersion, CoreVersion: ManagedXrayCoreVersion, Bindings: bindings}
	if p.DestinationPolicy != nil {
		descriptor.DestinationPolicy = entrypolicy.DestinationPolicy{AllowCIDRs: append([]string(nil), p.DestinationPolicy.AllowCIDRs...)}
	}
	raw, err := json.MarshalIndent(descriptor, "", "  ")
	if err != nil {
		return nil, err
	}
	return []domain.Artifact{{Path: "entry-policy.json", Content: string(raw) + "\n"}}, nil
}
func managedPrincipalBindings(p domain.ServerProgram) []entrypolicy.Binding {
	bindings := make([]entrypolicy.Binding, 0, len(p.Principals))
	for _, v := range p.Principals {
		bindings = append(bindings, entrypolicy.Binding{SubjectID: v.SubjectID, AccountID: v.AccountID, RouteID: v.RouteID, EntryID: p.Listener.ID, InboundTag: p.Listener.ID, CredentialVersion: v.CredentialVersion, PolicyRevision: v.PolicyRevision, CycleID: v.CycleID})
	}
	return bindings
}
func nativePrincipalUsers(p domain.ServerProgram, xray bool) []any {
	users := []any{}
	for _, v := range p.Principals {
		user := map[string]any{"uuid": v.Credential.UUID, "name": v.SubjectID}
		if xray {
			user = map[string]any{"id": v.Credential.UUID, "email": v.SubjectID}
		}
		if v.Credential.Flow != "" {
			user["flow"] = v.Credential.Flow
		}
		users = append(users, user)
	}
	return users
}
func principalRules(p domain.ServerProgram, xray bool) []any {
	rules := []any{}
	names := connectorNames(p)
	for _, v := range p.Principals {
		if xray {
			rules = append(rules, map[string]any{"type": "field", "inboundTag": []string{p.Listener.ID}, "user": []string{v.SubjectID}, "outboundTag": actionName(v.Action, names, "rw-direct", "rw-reject")})
		} else {
			rule := map[string]any{"inbound": []string{p.Listener.ID}, "auth_user": []string{v.SubjectID}}
			singboxAction(rule, v.Action, names)
			rules = append(rules, rule)
		}
	}
	return rules
}
