package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/domain"
	"routeweaver/internal/resources"
	"routeweaver/internal/store"
)

// Resource intent/provenance is private metadata. File delivery is separately
// authorized by resolving this owner's immutable accepted version and its bytes.
type ownedRuleResource struct {
	domain.RuleResource
	SourceURL        string    `json:"sourceUrl,omitempty"`
	AcceptedAt       time.Time `json:"acceptedAt,omitempty"`
	Inspection       string    `json:"inspection,omitempty"`
	RefreshStatus    string    `json:"refreshStatus,omitempty"`
	LastRefreshError string    `json:"lastRefreshError,omitempty"`
}

func (h *server) importRuleResource(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Resource      domain.RuleResource `json:"resource"`
		ContentBase64 *string             `json:"contentBase64,omitempty"`
		Fetch         bool                `json:"fetch,omitempty"`
	}
	if !decode(w, r, &in) {
		return
	}
	owner := current(r).Account.ID
	if err := ensureID(&in.Resource.ID); err != nil {
		storeError(w, err)
		return
	}
	if err := sameOwner(&in.Resource.OwnerID, owner); err != nil {
		fail(w, 403, err.Error())
		return
	}
	if (in.ContentBase64 == nil) == !in.Fetch {
		fail(w, 400, "supply exactly one uploaded file or an explicit fetch")
		return
	}
	if in.Resource.Path != "" || in.Resource.AcceptedVersion != "" || in.Resource.SizeBytes != 0 {
		fail(w, 400, "delivery paths and accepted versions are assigned by the server")
		return
	}
	var previous json.RawMessage
	if err := h.s.TenantGet(owner, "resources", in.Resource.ID, &previous); err != nil && !errors.Is(err, store.ErrNotFound) {
		storeError(w, err)
		return
	}
	var body []byte
	var sourceURL string
	if in.Fetch {
		sourceURL = in.Resource.URL
		fetched, err := resources.New(resources.Options{MaxBytes: resources.MaxRuleFileBytes, Timeout: 15 * time.Second}).Fetch(r.Context(), sourceURL)
		if err != nil {
			fail(w, 422, err.Error())
			return
		}
		body = fetched.Body
	} else {
		if in.Resource.URL != "" {
			fail(w, 400, "an uploaded file cannot claim a remote source URL")
			return
		}
		if len(*in.ContentBase64) > base64.StdEncoding.EncodedLen(resources.MaxRuleFileBytes) {
			fail(w, 413, "uploaded rule file exceeds size limit")
			return
		}
		var err error
		body, err = base64.StdEncoding.Strict().DecodeString(*in.ContentBase64)
		if err != nil {
			fail(w, 400, "invalid base64 file")
			return
		}
	}
	file, err := resources.AcceptRuleFile(in.Resource, body)
	if err != nil {
		fail(w, 422, err.Error())
		return
	}
	record := ownedRuleResource{RuleResource: file.Resource, SourceURL: sourceURL, AcceptedAt: time.Now().UTC(), Inspection: file.Inspection, RefreshStatus: "accepted"}
	if err = h.putAcceptedResource(owner, previous, record, file); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 201, resourceMetadata(record))
}

func resourceMetadata(v ownedRuleResource) any {
	canRefresh := v.SourceURL != ""
	v.SourceURL = ""
	return struct {
		ownedRuleResource
		NativeChecked bool `json:"nativeChecked"`
		CanRefresh    bool `json:"canRefresh"`
	}{v, false, canRefresh}
}

func (h *server) putAcceptedResource(owner string, previous json.RawMessage, record ownedRuleResource, file resources.RuleFile) error {
	var expected any
	if len(previous) > 0 {
		expected = previous
	}
	kind := store.TenantKind(owner, "resources")
	versionKind := store.TenantKind(owner, "resource-versions")
	compares := []store.RecordCompare{{Kind: kind, ID: record.ID, Expected: expected}}
	writes := []store.RecordWrite{{Kind: kind, ID: record.ID, Value: record}}
	var old resources.RuleFile
	err := h.s.TenantGet(owner, "resource-versions", file.Resource.AcceptedVersion, &old)
	if errors.Is(err, store.ErrNotFound) {
		compares = append(compares, store.RecordCompare{Kind: versionKind, ID: file.Resource.AcceptedVersion, Expected: nil})
		writes = append(writes, store.RecordWrite{Kind: versionKind, ID: file.Resource.AcceptedVersion, Value: file})
	} else if err != nil {
		return err
	} else {
		if err = resources.VerifyRuleFile(old); err != nil {
			return err
		}
		if old.Resource.OwnerID != owner || old.Resource.ID != record.ID || old.Resource.AcceptedVersion != file.Resource.AcceptedVersion {
			return fmt.Errorf("accepted resource version mismatch")
		}
		compares = append(compares, store.RecordCompare{Kind: versionKind, ID: file.Resource.AcceptedVersion, Expected: old})
	}
	return h.s.CompareAndPutRecords(compares, writes)
}

// Refresh is an explicit network mutation. Failure never replaces accepted bytes
// or silently updates a pin; new publication is blocked pending a successful
// refresh or explicit replacement. Previously frozen bundles remain unchanged.
func (h *server) refreshRuleResource(w http.ResponseWriter, r *http.Request) {
	owner := current(r).Account.ID
	var previous json.RawMessage
	if err := h.s.TenantGet(owner, "resources", chi.URLParam(r, "id"), &previous); err != nil {
		storeError(w, err)
		return
	}
	var record ownedRuleResource
	if err := json.Unmarshal(previous, &record); err != nil {
		fail(w, 500, "cannot read resource")
		return
	}
	if record.SourceURL == "" || record.AcceptedVersion == "" {
		fail(w, 409, "resource has no accepted remote source; import a file or URL explicitly")
		return
	}
	candidate := record.RuleResource
	if candidate.UpdatePolicy == "follow" {
		candidate.Digest = ""
	}
	file, err := resources.New(resources.Options{MaxBytes: resources.MaxRuleFileBytes, Timeout: 15 * time.Second}).FetchRuleFile(r.Context(), record.SourceURL, candidate)
	if err != nil {
		record.RefreshStatus = "failed"
		record.LastRefreshError = err.Error()
		if saveErr := h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: store.TenantKind(owner, "resources"), ID: record.ID, Expected: previous}}, []store.RecordWrite{{Kind: store.TenantKind(owner, "resources"), ID: record.ID, Value: record}}); saveErr != nil {
			storeError(w, saveErr)
			return
		}
		fail(w, 422, err.Error())
		return
	}
	record.RuleResource = file.Resource
	record.AcceptedAt = time.Now().UTC()
	record.RefreshStatus = "accepted"
	record.LastRefreshError = ""
	record.Inspection = file.Inspection
	if err = h.putAcceptedResource(owner, previous, record, file); err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, 200, resourceMetadata(record))
}

func resolveAcceptedRuleFile(owner string, r domain.RuleResource, reader tenantRecordReader) (resources.RuleFile, error) {
	var file resources.RuleFile
	if r.AcceptedVersion == "" || reader.TenantGet(owner, "resource-versions", r.AcceptedVersion, &file) != nil {
		return file, fmt.Errorf("rule file has no accepted owned version; import the file before publishing")
	}
	if file.Resource.OwnerID != owner || file.Resource.ID != r.ID || file.Resource.AcceptedVersion != r.AcceptedVersion || file.Resource.Digest != r.Digest || file.Resource.Format != r.Format || file.Resource.FormatVersion != r.FormatVersion || file.Resource.Behavior != r.Behavior || file.Resource.Path != r.Path || file.Resource.SizeBytes != r.SizeBytes {
		return file, fmt.Errorf("rule file version does not match its owned manifest")
	}
	if err := resources.VerifyRuleFile(file); err != nil {
		return file, err
	}
	return file, nil
}

func (h *server) resolveOwnedResource(owner string, ref domain.RuleResource, reader tenantRecordReader) (domain.RuleResource, error) {
	var current ownedRuleResource
	if err := reader.TenantGet(owner, "resources", ref.ID, &current); err != nil {
		return ref, fmt.Errorf("rule resource is missing or not owned; save the resource before referencing it")
	}
	if current.OwnerID != owner {
		return ref, fmt.Errorf("rule resource owner mismatch")
	}
	if current.RefreshStatus == "failed" {
		return ref, fmt.Errorf("rule resource refresh failed; refresh or explicitly replace the resource before publishing")
	}
	// A profile's explicitly pinned accepted version is independent of a later
	// replacement of the resource head. Follow selects the current accepted head.
	if ref.AcceptedVersion != "" && ref.UpdatePolicy == "pinned" {
		var file resources.RuleFile
		if reader.TenantGet(owner, "resource-versions", ref.AcceptedVersion, &file) != nil || file.Resource.OwnerID != owner || file.Resource.ID != ref.ID {
			return ref, fmt.Errorf("pinned rule resource version is missing or not owned")
		}
		if err := resources.VerifyRuleFile(file); err != nil {
			return ref, err
		}
		pinned := file.Resource
		pinned.UpdatePolicy = "pinned"
		return pinned, nil
	}
	resolved := current.RuleResource
	if resolved.AcceptedVersion != "" {
		if _, err := resolveAcceptedRuleFile(owner, resolved, reader); err != nil {
			return ref, err
		}
	} else if resolved.Location == "local" || resolved.Visibility != "public" || resolved.UpdatePolicy == "pinned" {
		return ref, fmt.Errorf("private and local rule files must be imported before use")
	}
	return resolved, nil
}
