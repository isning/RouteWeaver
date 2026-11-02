package agent

import (
	"encoding/json"
	"errors"
	"io"
	"strings"

	"routeweaver/internal/entrypolicy"
)

// This runs in Validate before executable probing and before Reconciler reaches
// any transition stop or Activate. The immutable desired artifacts are the same
// inputs later checked by verifyStage and the managed native configuration check.
func rejectManagedTerminalCapacity(d Desired) error {
	if d.AdapterID != ManagedXrayID {
		return nil
	}
	for _, artifact := range d.Artifacts {
		if artifact.Path != "entry-policy.json" {
			continue
		}
		if len(artifact.Content) > 8<<20 {
			return errors.New("managed policy artifact exceeds input bound")
		}
		var descriptor entrypolicy.Descriptor
		decoder := json.NewDecoder(strings.NewReader(artifact.Content))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&descriptor); err != nil {
			return errors.New("invalid managed policy artifact")
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			return errors.New("trailing managed policy artifact")
		}
		if descriptor.SchemaVersion != entrypolicy.SchemaVersion || descriptor.AdapterID != ManagedXrayID || descriptor.RuntimeVersion != ManagedXrayVersion {
			return errors.New("managed policy version mismatch")
		}
		return entrypolicy.ValidateTerminalCapacity(descriptor.Bindings)
	}
	return errors.New("managed policy artifact missing")
}
