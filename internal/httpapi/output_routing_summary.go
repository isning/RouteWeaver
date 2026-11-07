package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"unicode"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/domain"
	"routeweaver/internal/render"
)

// RoutingSummary is a frozen, allowlisted description of published intent, not
// the selector state of a client. Native semantics stay opaque.
type RoutingSummary struct {
	Version  int                     `json:"version"`
	Kind     string                  `json:"kind"`
	ChatGPT  *RoutingChoice          `json:"chatGPT,omitempty"`
	Default  *RoutingChoice          `json:"default,omitempty"`
	Advanced *AdvancedRoutingSummary `json:"advanced,omitempty"`
}
type RoutingChoice struct {
	EndpointID string `json:"endpointId"`
	Label      string `json:"label"`
}

// Counts describe the accepted configuration, not client liveness or health.
// RuleCount excludes the default action and does not expand rule-file contents.
// The optional block is absent on older publications; never backfill it on read.
type AdvancedRoutingSummary struct {
	DefaultAction RoutingDefaultAction `json:"defaultAction"`
	RuleCount     int                  `json:"ruleCount"`
	GroupCount    int                  `json:"groupCount"`
	NodeCount     int                  `json:"nodeCount"`
}

type RoutingDefaultAction struct {
	Kind  string `json:"kind"`
	Label string `json:"label,omitempty"`
}

func summarizeOutputRouting(p Profile, mode render.OutputMode, names map[string]string) *RoutingSummary {
	s := &RoutingSummary{Version: 1, Kind: "advanced"}
	if p.IR.NativeOverride != nil {
		s.Kind = "native-override"
		return s
	}
	if mode == render.NodesOnly {
		s.Kind = "nodes-only"
		return s
	}
	ir := p.IR
	if mode == render.FullConfig {
		s.Advanced = summarizeAdvancedRouting(ir, names)
	}
	if mode != render.FullConfig || p.CollectionID != "" || len(ir.Resources) != 0 || len(ir.Groups) != 2 || len(ir.Rules) != 4 || ir.DefaultAction != (domain.ActionRef{Kind: "group", Ref: "basic_default"}) {
		return s
	}
	for i, d := range []string{"chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com"} {
		r := ir.Rules[i]
		if r.ID != fmt.Sprintf("basic_chatgpt_%d", i) || r.Match.Op != "domain-suffix" || r.Match.Value != d || len(r.Match.Children) != 0 || r.Action != (domain.ActionRef{Kind: "group", Ref: "basic_chatgpt"}) {
			return s
		}
	}
	choices := make([]*RoutingChoice, 0, 2)
	for i, id := range []string{"basic_chatgpt", "basic_default"} {
		var found *domain.PolicyGroup
		for j := range ir.Groups {
			if ir.Groups[j].ID == id {
				found = &ir.Groups[j]
			}
		}
		if found == nil || found.Name != []string{"ChatGPT", "其他流量"}[i] || found.Kind != "manual" || found.Dynamic != nil || found.TestURL != "" || found.IntervalSeconds != 0 || found.ToleranceMS != 0 || found.Strategy != "" || len(found.Members) != 1 || found.Members[0].Kind != "endpoint" {
			return s
		}
		var choice *RoutingChoice
		for _, e := range ir.Endpoints {
			if e.ID == found.Members[0].Ref {
				label, ok := names[e.ID]
				if !ok {
					return s
				}
				choice = &RoutingChoice{EndpointID: e.ID, Label: safeRoutingLabel(label, ir.Endpoints)}
			}
		}
		if choice == nil {
			return s
		}
		choices = append(choices, choice)
	}
	s.Kind = "basic"
	s.Advanced = nil
	s.ChatGPT = choices[0]
	s.Default = choices[1]
	return s
}

// prepareOutput calls this only after materializing and successfully rendering
// accepted inputs. Names are allocated by that same render, never a raw draft.
func summarizeAdvancedRouting(ir domain.ClientProfileIR, names map[string]string) *AdvancedRoutingSummary {
	action := RoutingDefaultAction{Kind: ir.DefaultAction.Kind}
	switch action.Kind {
	case "direct", "reject":
	case "group", "endpoint":
		label, ok := names[ir.DefaultAction.Ref]
		if !ok {
			return nil
		}
		// A group names the policy that decides, not a selected live endpoint.
		action.Label = safeRoutingLabel(label, ir.Endpoints)
	default:
		return nil
	}
	return &AdvancedRoutingSummary{DefaultAction: action, RuleCount: len(ir.Rules), GroupCount: len(ir.Groups), NodeCount: len(ir.Endpoints)}
}

func safeRoutingLabel(label string, endpoints []domain.ClientEndpoint) string {
	return routingLabelSanitizer(endpoints)(label)
}

// Compile credential variants once when projecting many rules/labels. The
// existing coarse summary and private detail use the same privacy policy.
func routingLabelSanitizer(endpoints []domain.ClientEndpoint) func(string) string {
	// Imported names are display data, never a place to echo URLs or connection
	// credentials. Keep only the label, not a serialized endpoint/provenance value.
	// Names pass through adapter normalization and allocation's TrimSpace before
	// reaching metadata. Redact those known-secret variants too. Keep using the
	// existing adapter transform and longest-first redactor, not a second renderer.
	normalize := (render.MihomoClient{}).NormalizeName
	snapshots := []*domain.SourceSnapshot{{Endpoints: endpoints}}
	for _, transform := range []func(string) string{strings.TrimSpace, normalize, func(value string) string { return strings.TrimSpace(normalize(value)) }} {
		snapshot := &domain.SourceSnapshot{}
		for _, endpoint := range endpoints {
			c := endpoint.Connection
			variant := domain.Connection{Username: transform(c.Username), Password: transform(c.Password), UUID: transform(c.UUID)}
			if c.Transport != nil {
				variant.Transport = &domain.TransportOptions{Headers: map[string]string{}}
				for key, value := range c.Transport.Headers {
					variant.Transport.Headers[key] = transform(value)
				}
			}
			if c.TLS != nil && c.TLS.Reality != nil {
				variant.TLS = &domain.TLSOptions{Reality: &domain.RealityOptions{ShortID: transform(c.TLS.Reality.ShortID)}}
			}
			snapshot.Endpoints = append(snapshot.Endpoints, domain.ClientEndpoint{Connection: variant})
		}
		snapshots = append(snapshots, snapshot)
	}
	redact := sourceLabelRedactor(snapshots...)
	return func(label string) string {
		if strings.Contains(label, "://") || strings.Contains(label, "/feed/") {
			return "线路"
		}
		label = redact(label)
		label = strings.TrimSpace(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return -1
			}
			return r
		}, label))
		if label == "" {
			return "线路"
		}
		return label
	}
}

// Explicit owner detail and workbench checks prepare a candidate. Ordinary
// output listing remains a cheap read of frozen metadata.
func (h *server) outputStatus(w http.ResponseWriter, r *http.Request) {
	owner := current(r).Account.ID
	inputs := newTemplateInputs(h.s)
	var published Output
	if err := inputs.TenantGet(owner, "outputs", chi.URLParam(r, "id"), &published); err != nil {
		storeError(w, err)
		return
	}
	view := h.outputView(owner, published)
	// Selected owner detail may read the private frozen policy snapshot. Ordinary
	// list/access/share DTOs remain limited to outputView's coarse metadata.
	if published.RoutingIntent != nil {
		view["routingIntent"] = published.RoutingIntent
	}
	view["draftComparison"] = h.compareOutputDraft(owner, published, inputs)
	writeJSON(w, 200, view)
}

// A workbench check exposes only identity and comparison evidence. Deliberately
// do not reuse outputView or selected status: neither private intent nor access
// information belongs in this coarse, explicitly requested observation.
func (h *server) outputComparison(w http.ResponseWriter, r *http.Request) {
	owner := current(r).Account.ID
	inputs := newTemplateInputs(h.s)
	var published Output
	if err := inputs.TenantGet(owner, "outputs", chi.URLParam(r, "id"), &published); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{
		"id": published.ID, "profileId": published.ProfileID,
		"target": published.Target, "mode": published.Mode,
		"status": published.Status, "revision": published.Revision,
		"draftComparison": h.compareOutputDraft(owner, published, inputs),
	})
}

func (h *server) compareOutputDraft(owner string, published Output, inputs *templateInputs) map[string]string {
	comparison := map[string]string{"state": "unavailable"}
	if candidate, err := h.prepareOutput(owner, published, inputs); err == nil {
		comparison["state"] = "changed"
		// Legacy publications have no trustworthy summary to compare/backfill.
		if published.RoutingSummary == nil {
			comparison["state"] = "unavailable"
		} else if equalPublishedContent(published, candidate.output) {
			comparison["state"] = "unchanged"
		}
	} else {
		// A typed domain failure is known to be user-correctable. Expose only
		// an allowlisted cause/location, not draft references or raw errors.
		var missing *domain.MissingActionReferenceError
		if errors.As(err, &missing) {
			switch missing.Location.Kind {
			case "default", "group", "rule":
				comparison["reason"] = "missing-action-reference"
				comparison["location"] = missing.Location.Kind
			}
		}
	}
	return comparison
}

func equalPublishedContent(a, b Output) bool {
	if !reflect.DeepEqual(a.Artifacts, b.Artifacts) || !equalRoutingSummaries(a.RoutingSummary, b.RoutingSummary) || len(a.ResourceFiles) != len(b.ResourceFiles) {
		return false
	}
	// An old publication has no private snapshot; enrichment alone is not a
	// configuration change and must never backfill historical facts. When both
	// supported snapshots exist, stable references/order are meaningful even if
	// allocated labels happen to render identical bytes.
	if !equalKnownRoutingIntent(a.RoutingIntent, b.RoutingIntent) {
		return false
	}
	for i := range a.ResourceFiles {
		// Compare the actual bundled path and bytes, not bookkeeping metadata.
		x, y := a.ResourceFiles[i], b.ResourceFiles[i]
		if x.Resource.Path != y.Resource.Path || !reflect.DeepEqual(x.Body, y.Body) {
			return false
		}
	}
	return true
}

func equalRoutingSummaries(published, candidate *RoutingSummary) bool {
	if published != nil && candidate != nil && published.Version == 1 && candidate.Version == 1 && published.Kind == "advanced" && candidate.Kind == "advanced" && published.Advanced == nil {
		// Optional detail enrichment is not a pending configuration change. Still
		// compare all existing summary fields, artifacts and bundled resource bytes.
		// Copy rather than mutate: the candidate stays detailed and the stored
		// publication stays unavailable until the user actually publishes it.
		comparable := *candidate
		comparable.Advanced = nil
		return reflect.DeepEqual(published, &comparable)
	}
	return reflect.DeepEqual(published, candidate)
}
