// Package managedxray embeds the unchanged pinned upstream Xray module behind a
// policy-enforcing dispatcher. This is a distinct executable, not a stock-core
// configuration extension.
package managedxray

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"

	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/infra/conf"
	"routeweaver/internal/entrypolicy"
)

const AdapterID = "routeweaver/managed-xray"
const Version = "26.3.27-rw1"
const CoreVersion = "26.3.27"
const PolicyFile = "entry-policy.json"

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type managedStreamProfile struct {
	Network   string               `json:"network"`
	Security  string               `json:"security"`
	Sockopt   managedSocketOptions `json:"sockopt"`
	TCP       json.RawMessage      `json:"tcpSettings"`
	Raw       json.RawMessage      `json:"rawSettings"`
	FinalMask json.RawMessage      `json:"finalmask"`
	TLS       struct {
		ECHSockopt           json.RawMessage `json:"echSockopt"`
		PinnedPeerCertSha256 json.RawMessage `json:"pinnedPeerCertSha256"`
	} `json:"tlsSettings"`
}

func (s managedStreamProfile) supported() bool {
	return (s.Network == "" || s.Network == "tcp" || s.Network == "raw") && (s.Security == "" || s.Security == "none" || s.Security == "tls") && len(s.TCP) == 0 && len(s.Raw) == 0 && len(s.FinalMask) == 0 && len(s.TLS.ECHSockopt) == 0
}

// Only administrator-declared outbound dialerProxy edges are supported. Decode
// each occurrence instead of retaining the last RawMessage: native JSON merges
// repeated socket objects, which could otherwise hide an earlier unsafe option.
type managedSocketOptions struct {
	present     bool
	dialerProxy string
}

func (s *managedSocketOptions) UnmarshalJSON(raw []byte) error {
	if s.present {
		return errors.New("duplicate managed socket options")
	}
	s.present = true
	dec := json.NewDecoder(bytes.NewReader(raw))
	open, err := dec.Token()
	if err != nil || open != json.Delim('{') {
		return errors.New("unsupported managed socket options")
	}
	key, err := dec.Token()
	if err != nil || key != "dialerProxy" {
		return errors.New("only outbound dialerProxy socket options are supported")
	}
	if err = dec.Decode(&s.dialerProxy); err != nil || !identifier.MatchString(s.dialerProxy) {
		return errors.New("invalid outbound dialerProxy tag")
	}
	if dec.More() {
		return errors.New("extra managed socket options are unsupported")
	}
	close, err := dec.Token()
	if err != nil || close != json.Delim('}') || dec.Decode(new(any)) != io.EOF {
		return errors.New("invalid managed socket options")
	}
	return nil
}

func managedProxyProtocol(protocol string) bool {
	return protocol == "vless" || protocol == "socks" || protocol == "shadowsocks"
}

func validateManagedDetours(protocols, detours map[string]string) error {
	for tag, via := range detours {
		if !managedProxyProtocol(protocols[tag]) || !managedProxyProtocol(protocols[via]) {
			return errors.New("managed dialerProxy must reference a supported outbound proxy")
		}
	}
	// Each outbound has at most one predecessor. Iterative traversal is linear
	// and avoids stack growth for a large hand-authored native configuration.
	done := map[string]bool{}
	for tag := range detours {
		path := map[string]bool{}
		for current := tag; current != "" && !done[current]; current = detours[current] {
			if path[current] {
				return errors.New("cyclic managed dialerProxy chain")
			}
			path[current] = true
		}
		for current := range path {
			done[current] = true
		}
	}
	return nil
}

func DecodeDescriptor(r io.Reader) (entrypolicy.Descriptor, error) {
	var d entrypolicy.Descriptor
	dec := json.NewDecoder(io.LimitReader(r, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		return d, errors.New("invalid policy descriptor")
	}
	if dec.Decode(new(any)) != io.EOF {
		return d, errors.New("trailing policy descriptor data")
	}
	return d, nil
}

// Validate preserves native JSON grammar and adds a fail-closed capability and
// authenticated-principal mapping check. A successfully parsed stock file alone
// never demonstrates managed enforcement.
func Validate(native []byte, d entrypolicy.Descriptor) error {
	r, err := New(native, d, validationAdmission{})
	if err != nil {
		return err
	}
	return r.Close()
}

type validationAdmission struct{}

func (validationAdmission) Acquire(context.Context, entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	return entrypolicy.Lease{}, errors.New("validation never admits traffic")
}
func (validationAdmission) Release(context.Context, string) error { return nil }
func build(native []byte, d entrypolicy.Descriptor) (*core.Config, error) {
	if len(native) == 0 || len(native) > 8<<20 {
		return nil, errors.New("native config size out of bounds")
	}
	if core.Version() != CoreVersion || d.SchemaVersion != entrypolicy.SchemaVersion || d.AdapterID != AdapterID || d.RuntimeVersion != Version || d.CoreVersion != CoreVersion {
		return nil, errors.New("managed runtime or policy version mismatch")
	}
	if err := ValidateDestinationPolicy(d.DestinationPolicy); err != nil {
		return nil, err
	}
	if len(d.Bindings) == 0 || len(d.Bindings) > 1000 {
		return nil, errors.New("invalid binding count")
	}
	bindings := map[string]entrypolicy.Binding{}
	for _, b := range d.Bindings {
		for _, v := range []string{b.SubjectID, b.AccountID, b.RouteID, b.EntryID, b.InboundTag, b.CredentialVersion, b.PolicyRevision, b.CycleID} {
			if !identifier.MatchString(v) {
				return nil, errors.New("invalid policy binding identity")
			}
		}
		key := b.InboundTag + "\x00" + b.SubjectID
		if _, ok := bindings[key]; ok {
			return nil, errors.New("duplicate policy binding")
		}
		bindings[key] = b
	}
	if err := entrypolicy.ValidateTerminalCapacity(d.Bindings); err != nil {
		return nil, err
	}
	var raw struct {
		Outbounds []struct {
			Tag           string          `json:"tag"`
			Protocol      string          `json:"protocol"`
			ProxySettings json.RawMessage `json:"proxySettings"`
			Settings struct {
				VNext []struct {
					Users []struct {
						Flow string `json:"flow"`
					} `json:"users"`
				} `json:"vnext"`
			} `json:"settings"`
			Stream managedStreamProfile `json:"streamSettings"`
		} `json:"outbounds"`
		API      json.RawMessage `json:"api"`
		Reverse  json.RawMessage `json:"reverse"`
		Inbounds []struct {
			Tag      string `json:"tag"`
			Protocol string `json:"protocol"`
			Settings struct {
				Decryption string `json:"decryption"`
				Clients    []struct {
					ID      string          `json:"id"`
					Email   string          `json:"email"`
					Flow    string          `json:"flow"`
					Reverse json.RawMessage `json:"reverse"`
				} `json:"clients"`
				Fallbacks []json.RawMessage `json:"fallbacks"`
			} `json:"settings"`
			Stream   managedStreamProfile `json:"streamSettings"`
			Sniffing struct {
				Enabled bool `json:"enabled"`
			} `json:"sniffing"`
		} `json:"inbounds"`
	}
	dec := json.NewDecoder(bytes.NewReader(native))
	if err := dec.Decode(&raw); err != nil {
		return nil, errors.New("invalid native JSON")
	}
	if dec.Decode(new(any)) != io.EOF {
		return nil, errors.New("trailing native JSON data")
	}
	if len(raw.API) > 0 || len(raw.Reverse) > 0 {
		return nil, errors.New("dynamic inbound or reverse APIs unsupported on managed path")
	}
	if len(raw.Inbounds) == 0 {
		return nil, errors.New("no managed public entries")
	}
	protocols := map[string]string{}
	detours := map[string]string{}
	for _, out := range raw.Outbounds {
		if len(out.Stream.TLS.PinnedPeerCertSha256) != 0 {
			return nil, errors.New("certificate pinning unsupported on managed path")
		}
		switch out.Protocol {
		case "freedom", "blackhole", "socks", "shadowsocks", "vless":
		default:
			return nil, errors.New("untested managed egress protocol")
		}
		if !out.Stream.supported() {
			return nil, errors.New("untested managed egress transport, security or wrapper")
		}
		// proxySettings is an alternative native chaining mechanism. Reject it
		// rather than permit hidden edges to escape dialerProxy graph validation.
		if len(out.ProxySettings) != 0 {
			return nil, errors.New("managed outbound proxySettings unsupported; use dialerProxy")
		}
		if out.Tag != "" {
			if _, exists := protocols[out.Tag]; exists || !identifier.MatchString(out.Tag) {
				return nil, errors.New("duplicate or invalid outbound tag")
			}
			protocols[out.Tag] = out.Protocol
		}
		if out.Stream.Sockopt.present {
			if out.Tag == "" {
				return nil, errors.New("managed dialerProxy requires a named outbound")
			}
			detours[out.Tag] = out.Stream.Sockopt.dialerProxy
		}
		for _, endpoint := range out.Settings.VNext {
			for _, user := range endpoint.Users {
				if user.Flow != "" {
					return nil, errors.New("Vision egress is unverified on the managed path")
				}
			}
		}
	}
	if err := validateManagedDetours(protocols, detours); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	tags := map[string]bool{}
	for _, in := range raw.Inbounds {
		if len(in.Stream.TLS.PinnedPeerCertSha256) != 0 {
			return nil, errors.New("certificate pinning unsupported on managed path")
		}
		if tags[in.Tag] || !identifier.MatchString(in.Tag) {
			return nil, errors.New("duplicate or invalid inbound tag")
		}
		tags[in.Tag] = true
		if in.Protocol != "vless" || (in.Stream.Network != "" && in.Stream.Network != "tcp" && in.Stream.Network != "raw") {
			return nil, errors.New("managed path supports VLESS raw TCP only")
		}
		if in.Stream.Security != "" && in.Stream.Security != "none" && in.Stream.Security != "tls" {
			return nil, errors.New("untested entry security; Vision and REALITY are unsupported")
		}
		// PROXY headers and transport wrappers would replace the physical peer. They
		// need a separate trusted-ingress model and independent wire evidence.
		if in.Stream.Sockopt.present || len(in.Stream.TCP) > 0 || len(in.Stream.Raw) > 0 || len(in.Stream.FinalMask) > 0 || len(in.Stream.TLS.ECHSockopt) > 0 || in.Sniffing.Enabled {
			return nil, errors.New("untested entry socket, TCP wrapper or sniffing options")
		}
		if in.Settings.Decryption != "none" || len(in.Settings.Fallbacks) > 0 || len(in.Settings.Clients) == 0 {
			return nil, errors.New("unsupported managed VLESS settings")
		}
		ids := map[string]bool{}
		for _, user := range in.Settings.Clients {
			if user.Flow != "" || len(user.Reverse) > 0 {
				return nil, errors.New("Vision, flow and reverse users are unsupported")
			}
			if ids[user.ID] {
				return nil, errors.New("duplicate native credential")
			}
			ids[user.ID] = true
			key := in.Tag + "\x00" + user.Email
			if _, ok := bindings[key]; !ok || seen[key] {
				return nil, errors.New("native authenticated identity has no unique policy mapping")
			}
			seen[key] = true
		}
	}
	if len(seen) != len(bindings) {
		return nil, errors.New("policy binding has no native authenticated identity")
	}
	var nativeConfig conf.Config
	if err := json.Unmarshal(native, &nativeConfig); err != nil {
		return nil, errors.New("invalid native config")
	}
	out, err := nativeConfig.Build()
	if err != nil {
		return nil, fmt.Errorf("native config rejected: %w", err)
	}
	return out, nil
}
