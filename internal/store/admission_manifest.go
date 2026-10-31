package store

import (
	"database/sql"
	"encoding/json"
	"reflect"
	"routeweaver/internal/domain"
	"time"
)

// Read only the secret-free observation envelope. Core/runtime packages do not
// enter persistence; DeploymentIdentity is the shared frozen domain fence.
type appliedManifestObservation struct {
	Phase            string `json:"phase"`
	NativeChecked    bool   `json:"nativeChecked"`
	RecoveryRequired bool   `json:"recoveryRequired"`
	Observed         *struct {
		domain.DeploymentIdentity
		Known     bool `json:"known"`
		Quiescent bool `json:"quiescent"`
	} `json:"observed"`
}

func (s *Store) admissionManifestCurrent(tx *sql.Tx, binding EntryAdmissionBinding, grant admissionGrant, now time.Time) (bool, *time.Time, error) {
	if grant.PublishedRouteID == "" {
		return true, nil, nil
	}
	if grant.PublishedRouteID != binding.RouteID || grant.SubjectID != binding.SubjectID {
		return false, nil, nil
	}
	raw, e := s.listTx(tx, "agent-observations")
	if e != nil {
		return false, nil, e
	}
	manifests := []domain.PublishedManifest{}
	for _, b := range raw {
		var observation appliedManifestObservation
		if e = json.Unmarshal(b, &observation); e != nil {
			return false, nil, e
		}
		if observation.Phase != "observed_conformant" || !observation.NativeChecked || observation.RecoveryRequired || observation.Observed == nil || !observation.Observed.Known || !observation.Observed.Quiescent || observation.Observed.Generation == 0 {
			continue
		}
		identity := observation.Observed.DeploymentIdentity
		var manifest domain.PublishedManifest
		if e = s.getTx(tx, "published-manifests", identity.RevisionID, &manifest); e == ErrNotFound {
			continue
		} else if e != nil {
			return false, nil, e
		}
		if manifest.Identity != identity || manifest.Program.Instance.ID != identity.InstanceID || manifest.DeploymentID != grant.DeploymentID || !now.Before(manifest.PolicyExpiresAt) {
			continue
		}
		current, e := s.admissionScopeCurrent(tx, AdmissionScope{NodeID: identity.NodeID, InstanceID: identity.InstanceID, EnrollmentEpoch: identity.EnrollmentEpoch}, now)
		if e != nil {
			return false, nil, e
		}
		if !current {
			continue
		}
		var enrollment struct {
			ExpiresAt time.Time `json:"expiresAt"`
		}
		if e = s.getTx(tx, "instance-enrollments", identity.InstanceID, &enrollment); e != nil {
			return false, nil, e
		}
		if enrollment.ExpiresAt.Before(manifest.PolicyExpiresAt) {
			manifest.PolicyExpiresAt = enrollment.ExpiresAt
		}
		manifests = append(manifests, manifest)
	}
	for _, manifest := range manifests {
		if manifest.Program.Instance.ID != binding.InstanceID || manifest.Program.Listener.ID != binding.EntryID {
			continue
		}
		connection, route, e := domain.ResolvePublishedPrincipal(manifest, binding.SubjectID, binding.UserID, binding.RouteID, binding.CredentialVersion)
		if e != nil || !reflect.DeepEqual(connection, grant.Connection) {
			continue
		}
		covered := true
		until := manifest.PolicyExpiresAt
		for _, entry := range route.EndpointIDs {
			found := false
			for _, hop := range manifests {
				if hop.Program.Listener.ID == entry && hop.DeploymentID == manifest.DeploymentID && hop.Fingerprint == manifest.Fingerprint {
					found = true
					if hop.PolicyExpiresAt.Before(until) {
						until = hop.PolicyExpiresAt
					}
					break
				}
			}
			if !found {
				covered = false
				break
			}
		}
		if covered && len(route.EndpointIDs) > 0 {
			return true, &until, nil
		}
	}
	return false, nil, nil
}
