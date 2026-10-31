package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

// Preview errors may include a repair location for one narrowly typed domain
// failure. The legacy status and detail remain unchanged for every caller.
func failProfileValidation(w http.ResponseWriter, status int, err error) {
	var missing *domain.MissingActionReferenceError
	if !errors.As(err, &missing) {
		fail(w, status, err.Error())
		return
	}
	location := map[string]string{"kind": missing.Location.Kind}
	if missing.Location.ID != "" {
		location["id"] = missing.Location.ID
	}
	writeJSON(w, status, map[string]any{
		"detail": err.Error(),
		"validation": map[string]any{
			"code":      "missing_action_reference",
			"reference": map[string]string{"kind": missing.Reference.Kind, "id": missing.Reference.Ref},
			"location":  location,
		},
	})
}

// preparedOutput is shared by existing-output review and publication. All
// tenant inputs are captured once and the digest covers unredacted final bytes.
// Random publication revision/time are assigned only after review verification.
type preparedOutput struct {
	output Output
	result render.ClientResult
	digest string
}

func (h *server) prepareOutput(owner string, output Output, inputs *templateInputs) (preparedOutput, error) {
	var candidate preparedOutput
	if output.Name == "" {
		return candidate, fmt.Errorf("subscription name required")
	}
	var p Profile
	if err := inputs.TenantGet(owner, "profiles", output.ProfileID, &p); err != nil {
		return candidate, fmt.Errorf("profile missing or not owned")
	}
	if err := h.materializeProfileWithReader(owner, &p, inputs); err != nil {
		return candidate, err
	}
	if err := domain.ValidateClientProfile(p.IR); err != nil {
		return candidate, err
	}
	if output.Target.AdapterID == "" {
		output.Target = p.Target
	}
	if output.Mode == "" {
		output.Mode = p.Mode
	}
	p.IR.NameAllocations = output.NameAllocations
	result, err := render.DefaultClients().Render(p.IR, output.Target, output.Mode)
	if err != nil {
		return candidate, err
	}
	files, err := freezeOutputRuleFiles(owner, result.Resources, inputs)
	if err != nil {
		return candidate, err
	}
	output.ResourceFiles = files
	if len(result.Artifacts) != 1 {
		return candidate, fmt.Errorf("subscription requires one deliverable configuration")
	}
	output.PlatformDependencies = []EntryDependency{}
	for _, endpoint := range p.IR.Endpoints {
		if endpoint.Origin != "platform-entry" {
			continue
		}
		if len(endpoint.Provenance) != 1 {
			return candidate, fmt.Errorf("platform entry provenance missing")
		}
		ref := endpoint.Provenance[0]
		output.PlatformDependencies = append(output.PlatformDependencies, EntryDependency{ID: endpoint.ID, RouteID: ref.SourceID, CredentialVersion: ref.SnapshotID, ConnectionDigest: connectionDigest(endpoint.Connection)})
	}
	output.NameAllocations = result.NameAllocations
	output.Artifacts = result.Artifacts
	output.SemanticSnapshot = result.Semantics
	output.RoutingSummary = summarizeOutputRouting(p, output.Mode, result.Names)
	output.RoutingIntent = summarizeFrozenRoutingIntent(p.IR, output.Mode, result.Names, maxFrozenRoutingIntentBytes)
	encodedOutput, err := json.Marshal(output)
	if err == nil && len(encodedOutput) > 24<<20 && output.SemanticSnapshot != nil {
		// Optional comparison metadata must not reduce accepted publication size.
		output.SemanticSnapshot = nil
		encodedOutput, err = json.Marshal(output)
	}
	if err == nil && len(encodedOutput) > 24<<20 && output.RoutingIntent != nil {
		// Detail enrichment must not lower the existing publication capacity.
		// Keep an explicitly partial ordered snapshot when it fits; otherwise
		// retain unavailable detail rather than inventing or truncating policy.
		encodedIntent, _ := json.Marshal(output.RoutingIntent)
		budget := len(encodedIntent) - (len(encodedOutput) - (24 << 20))
		output.RoutingIntent = summarizeFrozenRoutingIntent(p.IR, output.Mode, result.Names, budget)
		encodedOutput, err = json.Marshal(output)
	}
	if err != nil || len(encodedOutput) > 24<<20 {
		return candidate, fmt.Errorf("output exceeds accepted record size limit")
	}
	// Version and owner prevent cross-purpose and cross-tenant digest reuse. The
	// exact captured output also binds retained names, revision and token state.
	raw, err := json.Marshal(struct {
		Scope  string
		Owner  string
		Inputs []store.RecordCompare
		Sets   []store.RecordSetCompare
		Output Output
		Result render.ClientResult
	}{"routeweaver/output-review/v1", owner, inputs.compares(), inputs.sets, output, result})
	if err != nil {
		return candidate, err
	}
	digest := sha256.Sum256(raw)
	return preparedOutput{output: output, result: result, digest: hex.EncodeToString(digest[:])}, nil
}

// publicationEffect describes the exact issuance decision of the captured output.
// It reveals no token or URL; the existing review digest binds that token state.
type outputPublicationEffect struct {
	Version int    `json:"version"`
	Link    string `json:"link"`
}

func (p preparedOutput) publicationEffect() *outputPublicationEffect {
	link := "preserve"
	if p.output.Token == "" {
		link = "replace"
	}
	return &outputPublicationEffect{Version: 1, Link: link}
}

type outputRoutingReview struct {
	SemanticChanges      *outputSemanticChanges
	NodeChanges          *outputNodeChanges
	PlatformEntryRefresh *outputPlatformEntryRefresh
	PublicationEffect    *outputPublicationEffect
	Candidate            *RoutingSummary
	Published            *RoutingSummary
	CandidateIntent      *FrozenRoutingIntent
	PublishedIntent      *FrozenRoutingIntent
}

func writeProfilePreview(w http.ResponseWriter, result render.ClientResult, outputID, scope, digest string, routing *outputRoutingReview) {
	// Redaction is presentation-only, after the exact final artifact digest.
	artifacts := append([]domain.Artifact(nil), result.Artifacts...)
	for i := range artifacts {
		artifacts[i].Content = redactArtifact(artifacts[i].Content)
	}
	resourceMetadata := append([]domain.RuleResource(nil), result.Resources...)
	for i := range resourceMetadata {
		resourceMetadata[i].URL = redactURL(resourceMetadata[i].URL)
	}
	response := map[string]any{"outputId": outputID, "previewScope": scope, "valid": true, "nativeChecked": false, "artifacts": artifacts, "resources": resourceMetadata, "names": result.Names, "nativeOverride": result.NativeOverride, "diagnostics": []string{}}
	if routing != nil {
		response["routingSummary"] = routing.Candidate
		if routing.CandidateIntent != nil {
			response["routingIntent"] = routing.CandidateIntent
		}
		if scope == "output-update" {
			if routing.SemanticChanges != nil {
				response["semanticChanges"] = routing.SemanticChanges
			}
			if routing.NodeChanges != nil {
				response["nodeChanges"] = routing.NodeChanges
			}
			if routing.PlatformEntryRefresh != nil {
				response["platformEntryRefresh"] = routing.PlatformEntryRefresh
			}
			if routing.PublicationEffect != nil {
				response["publicationEffect"] = routing.PublicationEffect
			}
			response["publishedRoutingSummary"] = routing.Published
			if routing.PublishedIntent != nil {
				response["publishedRoutingIntent"] = routing.PublishedIntent
			}
		}
	}
	if digest != "" {
		response["previewDigest"] = digest
	}
	writeJSON(w, 200, response)
}

// outputCreationRequest describes a new output, not an existing output review.
// The optional digest keeps legacy callers' current-input semantics explicit.
type outputCreationRequest struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	ProfileID     string            `json:"profileId"`
	Target        render.Target     `json:"target"`
	Mode          render.OutputMode `json:"mode"`
	PreviewDigest *string           `json:"previewDigest,omitempty"`
}

func (in outputCreationRequest) output() Output {
	return Output{ID: in.ID, Name: in.Name, ProfileID: in.ProfileID, Target: in.Target, Mode: in.Mode}
}

func (h *server) previewNewOutput(w http.ResponseWriter, r *http.Request) {
	var in outputCreationRequest
	if !decode(w, r, &in) {
		return
	}
	if in.ID == "" || !domain.ValidID(in.ID) {
		fail(w, 422, "new output preview requires a stable output id")
		return
	}
	owner := current(r).Account.ID
	var old Output
	if err := h.s.TenantGet(owner, "outputs", in.ID, &old); err == nil {
		fail(w, 409, "output id already exists")
		return
	}
	prepared, err := h.prepareOutput(owner, in.output(), newTemplateInputs(h.s))
	if err != nil {
		failProfileValidation(w, 422, err)
		return
	}
	writeProfilePreview(w, prepared.result, in.ID, "new-output", prepared.digest, &outputRoutingReview{Candidate: prepared.output.RoutingSummary, CandidateIntent: prepared.output.RoutingIntent})
}
