package reuse

import (
	"fmt"
	"regexp"
	"routeweaver/internal/domain"
	"strings"
)

const (
	ProcessingPreset = "processing-preset"
	ClientProfile    = "client-profile"
	Copy             = "copy"
	Pinned           = "pinned"
	Follow           = "follow"
)

// These allowlisted structures deliberately have no owner, endpoint connection,
// subscription URL, source ID, resource URL/path, access token or native blob.
// Private values are bound only while materializing in the selecting tenant.
type Filter struct {
	NamePattern string   `json:"namePattern,omitempty"`
	Protocol    string   `json:"protocol,omitempty"`
	Region      string   `json:"region,omitempty"`
	Tags        []string `json:"tags,omitempty"`
}
type MetadataOverride struct {
	Region *string   `json:"region,omitempty"`
	Tags   *[]string `json:"tags,omitempty"`
}
type Step struct {
	ID         string           `json:"id"`
	Enabled    bool             `json:"enabled"`
	Kind       string           `json:"kind"`
	Filter     Filter           `json:"filter,omitempty"`
	Template   string           `json:"template,omitempty"`
	SortBy     string           `json:"sortBy,omitempty"`
	Descending bool             `json:"descending,omitempty"`
	Override   MetadataOverride `json:"override,omitempty"`
}
type Slot struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Group struct {
	ID              string             `json:"id"`
	Name            string             `json:"name"`
	Kind            string             `json:"kind"`
	Members         []domain.ActionRef `json:"members"`
	Dynamic         *Filter            `json:"dynamic,omitempty"`
	IntervalSeconds int                `json:"intervalSeconds,omitempty"`
	ToleranceMS     int                `json:"toleranceMs,omitempty"`
	Strategy        string             `json:"strategy,omitempty"`
}
type Spec struct {
	Steps         []Step               `json:"steps,omitempty"`
	EndpointSlots []Slot               `json:"endpointSlots,omitempty"`
	ResourceSlots []Slot               `json:"resourceSlots,omitempty"`
	Groups        []Group              `json:"groups,omitempty"`
	Rules         []domain.PolicyRule  `json:"rules,omitempty"`
	DefaultAction domain.ActionRef     `json:"defaultAction,omitempty"`
	Runtime       domain.ClientRuntime `json:"runtime,omitempty"`
}
type Bindings struct {
	Endpoints map[string]string `json:"endpoints,omitempty"`
	Resources map[string]string `json:"resources,omitempty"`
}

func (f Filter) domain() domain.EndpointFilter {
	return domain.EndpointFilter{NamePattern: f.NamePattern, Protocol: f.Protocol, Region: f.Region, Tags: clone(f.Tags)}
}
func filter(f domain.EndpointFilter) (Filter, error) {
	if f.SourceID != "" {
		return Filter{}, fmt.Errorf("source-specific filters cannot be shared; replace with a metadata filter first")
	}
	return Filter{NamePattern: f.NamePattern, Protocol: f.Protocol, Region: f.Region, Tags: clone(f.Tags)}, nil
}
func (s Spec) ProcessingSteps() []domain.ProcessingStep {
	out := []domain.ProcessingStep{}
	for _, v := range s.Steps {
		out = append(out, domain.ProcessingStep{ID: v.ID, Enabled: v.Enabled, Kind: v.Kind, Filter: v.Filter.domain(), Template: v.Template, SortBy: v.SortBy, Descending: v.Descending, Override: domain.EndpointOverride{Region: clone(v.Override.Region), Tags: clone(v.Override.Tags)}})
	}
	return out
}

func Validate(kind string, s Spec) error {
	if kind != ProcessingPreset && kind != ClientProfile {
		return fmt.Errorf("template kind must be processing-preset or client-profile")
	}
	if kind == ProcessingPreset {
		if len(s.EndpointSlots)+len(s.ResourceSlots)+len(s.Groups)+len(s.Rules) > 0 || s.DefaultAction.Kind != "" || s.DefaultAction.Ref != "" || s.Runtime.MixedPort != 0 || s.Runtime.DNS != nil || s.Runtime.TUN != nil || s.Runtime.Sniff {
			return fmt.Errorf("processing preset cannot contain profile fields")
		}
		if len(s.Steps) == 0 {
			return fmt.Errorf("processing preset requires steps")
		}
		seen := map[string]bool{}
		for _, v := range s.Steps {
			if !domain.ValidID(v.ID) || seen[v.ID] {
				return fmt.Errorf("invalid or duplicate processing step identity")
			}
			seen[v.ID] = true
			if err := domain.ValidateFilter(v.Filter.domain()); err != nil {
				return err
			}
			switch v.Kind {
			case "keep", "drop", "deduplicate", "override":
			case "sort":
				if v.SortBy != "name" && v.SortBy != "region" && v.SortBy != "protocol" {
					return fmt.Errorf("unknown sorting field")
				}
			case "rename":
				text := strings.NewReplacer("{name}", "Name", "{region}", "Region", "{id}", "id", "{source}", "source").Replace(v.Template)
				if strings.TrimSpace(text) == "" || len(text) > 160 || strings.ContainsAny(text, "{}\r\n") || strings.Contains(text, "://") {
					return fmt.Errorf("rename template must be a display name with known placeholders, not a URL")
				}
			default:
				return fmt.Errorf("unknown processing step kind")
			}
		}
		return nil
	}
	if len(s.Steps) > 0 {
		return fmt.Errorf("client profile template cannot contain processing steps")
	}
	endpoints, resources := map[string]bool{}, map[string]bool{}
	for _, item := range []struct {
		slots []Slot
		seen  map[string]bool
	}{{s.EndpointSlots, endpoints}, {s.ResourceSlots, resources}} {
		for _, v := range item.slots {
			if !domain.ValidID(v.ID) || item.seen[v.ID] || strings.TrimSpace(v.Name) == "" {
				return fmt.Errorf("invalid or duplicate binding slot")
			}
			item.seen[v.ID] = true
		}
	}
	// Validate policy against synthetic slots, never against an administrator's
	// private endpoint material. Target-specific checks occur on tenant selection.
	fixture := domain.ClientProfileIR{SchemaVersion: "1.0", ID: "template", Name: "Template", OwnerID: "template-owner", Revision: "1", DefaultAction: s.DefaultAction, Runtime: s.Runtime}
	binding := Bindings{Endpoints: map[string]string{}, Resources: map[string]string{}}
	for _, v := range s.EndpointSlots {
		binding.Endpoints[v.ID] = v.ID
		fixture.Endpoints = append(fixture.Endpoints, domain.ClientEndpoint{ID: v.ID, Name: v.Name, OwnerID: fixture.OwnerID, Origin: "imported", Connection: domain.Connection{Host: "192.0.2.1", Port: 1080, Protocol: "socks"}})
	}
	for _, v := range s.ResourceSlots {
		binding.Resources[v.ID] = v.ID
		fixture.Resources = append(fixture.Resources, domain.RuleResource{ID: v.ID, Name: v.Name, OwnerID: fixture.OwnerID, Revision: "1", Digest: "sha256:" + strings.Repeat("0", 64), Format: "mihomo-text", Behavior: "domain", Location: "local", Path: v.ID + ".txt", UpdatePolicy: "pinned"})
	}
	instantiated, err := s.Instantiate(fixture, binding)
	if err != nil {
		return err
	}
	// Dynamic selection is evaluated only against the selecting tenant. A synthetic
	// direct member allows shape validation here without inventing private nodes.
	for i := range instantiated.Groups {
		if instantiated.Groups[i].Dynamic != nil {
			instantiated.Groups[i].Members = append(instantiated.Groups[i].Members, domain.ActionRef{Kind: "direct"})
		}
	}
	return domain.ValidateClientProfile(instantiated)
}

// Instantiate returns an isolated policy-only baseline with private references
// resolved from the user's own materialized profile, never another tenant.
func (s Spec) Instantiate(local domain.ClientProfileIR, b Bindings) (domain.ClientProfileIR, error) {
	out := clone(local)
	out.Groups = []domain.PolicyGroup{}
	out.Rules = clone(s.Rules)
	out.DefaultAction = s.DefaultAction
	out.Runtime = clone(s.Runtime)
	endpointIDs, resourceIDs := map[string]bool{}, map[string]bool{}
	for _, v := range local.Endpoints {
		if v.OwnerID != local.OwnerID {
			return out, fmt.Errorf("endpoint ownership mismatch")
		}
		endpointIDs[v.ID] = true
	}
	for _, v := range local.Resources {
		if v.OwnerID != "" && v.OwnerID != local.OwnerID {
			return out, fmt.Errorf("resource ownership mismatch")
		}
		resourceIDs[v.ID] = true
	}
	if len(b.Endpoints) != len(s.EndpointSlots) || len(b.Resources) != len(s.ResourceSlots) {
		return out, fmt.Errorf("bind every declared slot and no extra slots")
	}
	for _, v := range s.EndpointSlots {
		if !endpointIDs[b.Endpoints[v.ID]] {
			return out, fmt.Errorf("endpoint slot %s is missing or not owned", v.ID)
		}
	}
	for _, v := range s.ResourceSlots {
		if !resourceIDs[b.Resources[v.ID]] {
			return out, fmt.Errorf("resource slot %s is missing or not owned", v.ID)
		}
	}
	action := func(a domain.ActionRef) domain.ActionRef {
		if a.Kind == "endpoint" {
			a.Ref = b.Endpoints[a.Ref]
		}
		return a
	}
	var match func(*domain.MatchExpression)
	match = func(m *domain.MatchExpression) {
		if m.Op == "resource" {
			m.Value = b.Resources[m.Value]
		}
		for i := range m.Children {
			match(&m.Children[i])
		}
	}
	for _, g := range s.Groups {
		d := domain.PolicyGroup{ID: g.ID, Name: g.Name, Kind: g.Kind, Members: clone(g.Members), IntervalSeconds: g.IntervalSeconds, ToleranceMS: g.ToleranceMS, Strategy: g.Strategy}
		if g.Dynamic != nil {
			f := g.Dynamic.domain()
			d.Dynamic = &f
		}
		if g.Kind != "manual" {
			d.TestURL = "https://www.gstatic.com/generate_204"
		}
		for i := range d.Members {
			d.Members[i] = action(d.Members[i])
		}
		out.Groups = append(out.Groups, d)
	}
	for i := range out.Rules {
		out.Rules[i].Action = action(out.Rules[i].Action)
		match(&out.Rules[i].Match)
	}
	out.DefaultAction = action(out.DefaultAction)
	return out, nil
}

// SanitizeProfile is an allowlist projection, not recursive secret-key stripping.
// All connections/resource locations become generic slots, all source identities
// disappear, and health-check URLs become a fixed public test URL.
func SanitizeProfile(p domain.ClientProfileIR) (Spec, error) {
	out := Spec{Rules: clone(p.Rules), DefaultAction: p.DefaultAction, Runtime: clone(p.Runtime)}
	endpoints, resources := map[string]string{}, map[string]string{}
	for i, e := range p.Endpoints {
		slot := fmt.Sprintf("endpoint-%d", i+1)
		endpoints[e.ID] = slot
		out.EndpointSlots = append(out.EndpointSlots, Slot{ID: slot, Name: fmt.Sprintf("Endpoint %d", i+1)})
	}
	for i, r := range p.Resources {
		slot := fmt.Sprintf("resource-%d", i+1)
		resources[r.ID] = slot
		out.ResourceSlots = append(out.ResourceSlots, Slot{ID: slot, Name: fmt.Sprintf("Rule resource %d", i+1)})
	}
	action := func(a domain.ActionRef) domain.ActionRef {
		if a.Kind == "endpoint" {
			a.Ref = endpoints[a.Ref]
		}
		return a
	}
	var match func(*domain.MatchExpression)
	match = func(m *domain.MatchExpression) {
		if m.Op == "resource" {
			m.Value = resources[m.Value]
		}
		for i := range m.Children {
			match(&m.Children[i])
		}
	}
	for _, g := range p.Groups {
		v := Group{ID: g.ID, Name: g.Name, Kind: g.Kind, Members: clone(g.Members), IntervalSeconds: g.IntervalSeconds, ToleranceMS: g.ToleranceMS, Strategy: g.Strategy}
		if g.Dynamic != nil {
			f, e := filter(*g.Dynamic)
			if e != nil {
				return Spec{}, e
			}
			v.Dynamic = &f
		}
		for i := range v.Members {
			v.Members[i] = action(v.Members[i])
		}
		out.Groups = append(out.Groups, v)
	}
	for i := range out.Rules {
		out.Rules[i].Action = action(out.Rules[i].Action)
		match(&out.Rules[i].Match)
	}
	out.DefaultAction = action(out.DefaultAction)
	return out, nil
}
func SanitizeSteps(steps []domain.ProcessingStep) (Spec, error) {
	out := Spec{}
	for _, s := range steps {
		if s.Override.Host != nil || s.Override.Port != nil {
			return Spec{}, fmt.Errorf("private connection overrides cannot be shared")
		}
		f, e := filter(s.Filter)
		if e != nil {
			return Spec{}, e
		}
		out.Steps = append(out.Steps, Step{ID: s.ID, Enabled: s.Enabled, Kind: s.Kind, Filter: f, Template: s.Template, SortBy: s.SortBy, Descending: s.Descending, Override: MetadataOverride{Region: clone(s.Override.Region), Tags: clone(s.Override.Tags)}})
	}
	return out, Validate(ProcessingPreset, out)
}

var label = regexp.MustCompile(`^[^\r\n]{1,160}$`)

func ValidName(s string) bool { return strings.TrimSpace(s) != "" && label.MatchString(s) }
