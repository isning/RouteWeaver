package httpapi

import (
	"routeweaver/internal/domain"
	"routeweaver/internal/resources"
)

// withinPlatformResourceBudget admits only small opaque/local accepted bytes.
// It must run BEFORE materialization, whose VerifyRuleFile calls parse envelopes.
// Integrity verification remains in the ordinary materialization/freeze path;
// this gate does not assert native validity or fetch any remote source.
func withinPlatformResourceBudget(owner string, p Profile, inputs tenantRecordReader) bool {
	if len(p.IR.Resources) > 4 {
		return false
	}
	total := 0
	for _, ref := range p.IR.Resources {
		if !domain.ValidID(ref.ID) || (ref.OwnerID != "" && ref.OwnerID != owner) {
			return false
		}
		var head ownedRuleResource
		if inputs.TenantGet(owner, "resources", ref.ID, &head) != nil || head.ID != ref.ID || head.OwnerID != owner || head.RefreshStatus == "failed" || head.Location != "local" || head.AcceptedVersion == "" {
			return false
		}
		version := head.AcceptedVersion
		if ref.UpdatePolicy == "pinned" && ref.AcceptedVersion != "" {
			version = ref.AcceptedVersion
		}
		var file resources.RuleFile
		if inputs.TenantGet(owner, "resource-versions", version, &file) != nil || file.Resource.ID != ref.ID || file.Resource.OwnerID != owner || file.Resource.AcceptedVersion != version || file.Resource.Location != "local" || file.Resource.URL != "" {
			return false
		}
		switch file.Resource.Format {
		case "mihomo-text", "srs", "mrs":
		default:
			return false
		}
		if len(file.Body) == 0 || len(file.Body) > 4096 || file.Resource.SizeBytes != int64(len(file.Body)) {
			return false
		}
		total += len(file.Body)
		if total > 16384 {
			return false
		}
		// Follow/head resolution verifies these fields before parsing. Requiring
		// equality here also ensures a supported body cannot hide a different format.
		if !(ref.UpdatePolicy == "pinned" && ref.AcceptedVersion != "") {
			r := file.Resource
			if r.Digest != head.Digest || r.Format != head.Format || r.FormatVersion != head.FormatVersion || r.Behavior != head.Behavior || r.Path != head.Path || r.SizeBytes != head.SizeBytes {
				return false
			}
		}
	}
	return true
}
