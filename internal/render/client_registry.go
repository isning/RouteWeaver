package render

import (
	"encoding/json"
	"fmt"
	"routeweaver/internal/domain"
	"sort"
	"strings"
)

const (
	MihomoVersion  = "1.19.32"
	SingBoxVersion = "1.14.3"
	XrayVersion    = "26.3.27"
)

type OutputMode string

const (
	FullConfig OutputMode = "full"
	NodesOnly  OutputMode = "nodes-only"
)

type Target struct {
	AdapterID string `json:"adapterId"`
	Version   string `json:"version"`
}
type ClientCapability struct {
	NativeOverride  *NativeCapability `json:"nativeOverride,omitempty"`
	AdapterID       string            `json:"adapterId"`
	Versions        []string          `json:"versions"`
	Protocols       []string          `json:"protocols"`
	Groups          []string          `json:"groups"`
	MatchOps        []string          `json:"matchOps"`
	ResourceFormats []string          `json:"resourceFormats"`
	Runtime         []string          `json:"runtime"`
	ReservedNames   []string          `json:"reservedNames,omitempty"`
	TLSFingerprints []string          `json:"tlsFingerprints,omitempty"`
}
type ClientResult struct {
	Semantics       *SemanticSnapshot                `json:"-"`
	NativeOverride  *NativeOverrideReport            `json:"nativeOverride,omitempty"`
	Artifacts       []domain.Artifact                `json:"artifacts"`
	Resources       []domain.RuleResource            `json:"resources"`
	Names           map[string]string                `json:"names"`
	NameAllocations map[string]domain.NameAllocation `json:"nameAllocations,omitempty"`
}
type ClientRenderer interface {
	ClientCapability() ClientCapability
	NormalizeName(string) string
	RenderClient(domain.ClientProfileIR, Target, OutputMode, map[string]string) (ClientResult, error)
}
type ClientRegistry struct{ adapters map[string]ClientRenderer }

func NewClients(adapters ...ClientRenderer) *ClientRegistry {
	r := &ClientRegistry{adapters: map[string]ClientRenderer{}}
	for _, a := range adapters {
		if err := r.Register(a); err != nil {
			panic(err)
		}
	}
	return r
}
func (r *ClientRegistry) Register(a ClientRenderer) error {
	c := a.ClientCapability()
	if !validAdapterID(c.AdapterID) || len(c.Versions) == 0 {
		return fmt.Errorf("invalid client adapter descriptor")
	}
	if _, ok := r.adapters[c.AdapterID]; ok {
		return fmt.Errorf("client adapter already registered")
	}
	r.adapters[c.AdapterID] = a
	return nil
}
func (r *ClientRegistry) Capabilities() []ClientCapability {
	out := []ClientCapability{}
	for _, a := range r.adapters {
		out = append(out, a.ClientCapability())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AdapterID < out[j].AdapterID })
	return out
}
func (r *ClientRegistry) Render(p domain.ClientProfileIR, target Target, mode OutputMode) (ClientResult, error) {
	if mode != FullConfig && mode != NodesOnly {
		return ClientResult{}, fmt.Errorf("OUTPUT_MODE_UNSUPPORTED: select full or nodes-only")
	}
	a, ok := r.adapters[target.AdapterID]
	if !ok {
		return ClientResult{}, fmt.Errorf("TARGET_UNSUPPORTED: client adapter not registered")
	}
	c := a.ClientCapability()
	if !has(c.Versions, target.Version) {
		return ClientResult{}, fmt.Errorf("TARGET_VERSION_UNVERIFIED: select an explicitly supported version")
	}
	if p.NativeOverride != nil {
		if c.NativeOverride == nil {
			return ClientResult{}, nativeError("UNSUPPORTED", "/nativeOverride/target", "adapter does not declare native editing")
		}
		if err := validateNativeEnvelope(p.NativeOverride, target, mode); err != nil {
			return ClientResult{}, err
		}
	}
	// Nodes-only exports intentionally omit policy and runtime. Invalid endpoint
	// ownership/connection data remains fatal; unsupported full policy is irrelevant.
	if mode == NodesOnly {
		p.Groups = nil
		p.Rules = nil
		p.Resources = nil
		p.Runtime = domain.ClientRuntime{}
		p.DefaultAction = domain.ActionRef{Kind: "direct"}
	}
	if err := domain.ValidateClientProfile(p); err != nil {
		return ClientResult{}, err
	}
	namesInput := []domain.NamedIdentity{}
	for i, e := range p.Endpoints {
		if err := validateClientConnection(e.Connection, c); err != nil {
			return ClientResult{}, fmt.Errorf("endpoints[%d]: %w", i, err)
		}
		namesInput = append(namesInput, domain.NamedIdentity{ID: e.ID, Name: a.NormalizeName(e.Name)})
	}
	for i, g := range p.Groups {
		if !has(c.Groups, g.Kind) {
			return ClientResult{}, fmt.Errorf("GROUP_STRATEGY_UNSUPPORTED: groups[%d] target cannot preserve %s", i, g.Kind)
		}
		namesInput = append(namesInput, domain.NamedIdentity{ID: g.ID, Name: a.NormalizeName(g.Name)})
	}
	for i, rule := range p.Rules {
		if !matchSupported(rule.Match, c.MatchOps) {
			return ClientResult{}, fmt.Errorf("RULE_SEMANTICS_UNSUPPORTED: rules[%d]", i)
		}
	}
	for i, res := range p.Resources {
		if !has(c.ResourceFormats, res.Format) {
			return ClientResult{}, fmt.Errorf("RULE_FORMAT_UNSUPPORTED: resources[%d]; select a compatible file, no inline conversion is performed", i)
		}
		if res.Visibility != "public" && res.Location == "remote" {
			return ClientResult{}, fmt.Errorf("PRIVATE_RESOURCE_DELIVERY_UNSUPPORTED: resources[%d] requires authorized local packaging", i)
		}
	}
	for name, required := range map[string]bool{"dns": p.Runtime.DNS != nil, "sniff": p.Runtime.Sniff, "tun": p.Runtime.TUN != nil && p.Runtime.TUN.Enabled} {
		if required && !has(c.Runtime, name) {
			return ClientResult{}, fmt.Errorf("RUNTIME_OPTION_UNSUPPORTED: runtime.%s", name)
		}
	}
	previous := map[string]domain.NameAllocation{}
	for id, allocation := range p.NameAllocations {
		if a.NormalizeName(allocation.OutputName) == allocation.OutputName {
			previous[id] = allocation
		}
	}
	allocations, err := domain.AllocateNames(namesInput, previous, c.ReservedNames...)
	if err != nil {
		return ClientResult{}, err
	}
	p.NameAllocations = allocations
	names := map[string]string{}
	for id, allocation := range allocations {
		names[id] = allocation.OutputName
	}
	result, err := a.RenderClient(p, target, mode, names)
	if err != nil {
		return ClientResult{}, err
	}
	return applyNativeOverride(p, target, mode, result)
}
func DefaultClients() *ClientRegistry { return NewClients(MihomoClient{}, SingBoxClient{}) }
func validAdapterID(s string) bool {
	parts := strings.Split(s, "/")
	if len(parts) > 2 {
		return false
	}
	for _, p := range parts {
		if !domain.ValidID(p) {
			return false
		}
	}
	return true
}
func has(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
func matchSupported(m domain.MatchExpression, ops []string) bool {
	if !has(ops, m.Op) {
		return false
	}
	for _, c := range m.Children {
		if !matchSupported(c, ops) {
			return false
		}
	}
	return true
}
func clientResult(path string, config any, p domain.ClientProfileIR, names map[string]string) (ClientResult, error) {
	b, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return ClientResult{}, err
	}
	return ClientResult{Artifacts: []domain.Artifact{{Path: path, Content: string(b) + "\n"}}, Resources: append([]domain.RuleResource{}, p.Resources...), Names: names, NameAllocations: p.NameAllocations}, nil
}
func actionName(a domain.ActionRef, names map[string]string, direct, reject string) string {
	switch a.Kind {
	case "direct":
		return direct
	case "reject":
		return reject
	default:
		return names[a.Ref]
	}
}
