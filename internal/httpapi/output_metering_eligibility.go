package httpapi

import (
	"errors"
	"fmt"
	"time"

	"routeweaver/internal/store"
)

type independentMeteringEligibility struct {
	Available bool   `json:"available"`
	Required  bool   `json:"required"`
	Reason    string `json:"reason,omitempty"`
}

type independentEligibilityError struct {
	reason string
	err    error
}

func (e *independentEligibilityError) Error() string { return e.err.Error() }
func (e *independentEligibilityError) Unwrap() error { return e.err }
func meteringUnavailable(reason string, err error) error {
	return &independentEligibilityError{reason, err}
}

func platformOnlyProfile(p Profile) bool {
	if len(p.PlatformEntryIDs) == 0 || len(p.SourceIDs) != 0 || p.CollectionID != "" {
		return false
	}
	for _, endpoint := range p.IR.Endpoints {
		if endpoint.Origin == "imported" {
			return false
		}
	}
	return true
}

// Reuse the actual reservation preparation, including capability, applied runtime,
// policy and capacity checks. This discards the private candidate: no reservation,
// credential, service job, or configuration is persisted or returned. The eventual
// POST still performs its own atomic authorization and configuration comparisons.
func (h *server) independentMeteringEligibility(owner string, in outputCreationRequest) independentMeteringEligibility {
	result := independentMeteringEligibility{Reason: "unavailable"}
	var p Profile
	if err := h.s.TenantGet(owner, "profiles", in.ProfileID, &p); err != nil {
		return result
	}
	if !platformOnlyProfile(p) {
		result.Reason = "not_platform_only"
		return result
	}
	result.Required = true
	if len(p.PlatformEntryIDs) > 16 {
		result.Reason = "entry_limit"
		return result
	}
	// A preview establishes a new review, not a reservation of a previous digest.
	in.PreviewDigest = nil
	_, _, err := h.prepareAttributedOutputReservation(owner, in, "", time.Now().UTC())
	if err == nil {
		result.Available = true
		result.Reason = ""
		return result
	}
	var classified *independentEligibilityError
	if errors.As(err, &classified) {
		result.Reason = classified.reason
	} else if errors.Is(err, store.ErrAttributionCapacity) {
		result.Reason = "capacity_reached"
	}
	return result
}

var errIndependentMeteringRequired = fmt.Errorf("platform-only subscriptions require independent metering; review and provision independent credentials")
