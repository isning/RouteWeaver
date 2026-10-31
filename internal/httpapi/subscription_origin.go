package httpapi

import (
	"errors"
	"net/http"
	"routeweaver/internal/resources"
	"routeweaver/internal/store"
	"time"

	"github.com/go-chi/chi/v5"
)

// Subscription origins only choose generated link addresses. They never alter
// the browser's trusted mutation origin, install TLS, change DNS, or redirect a
// feed credential. A successful probe is a dated observation, not uptime status.
type subscriptionOriginState struct {
	Revision              uint64     `json:"revision"`
	ConfiguredRevision    uint64     `json:"configuredRevision"`
	DraftOrigin           string     `json:"draftOrigin"`
	EffectiveRevision     uint64     `json:"effectiveRevision"`
	EffectiveOrigin       string     `json:"effectiveOrigin"`
	VerifiedAt            *time.Time `json:"verifiedAt,omitempty"`
	VerificationExpiresAt *time.Time `json:"verificationExpiresAt,omitempty"`
	LastFailure           string     `json:"lastFailure,omitempty"`
	ActivatedAt           *time.Time `json:"activatedAt,omitempty"`
}

// The persisted proof revision is not a credential, but belongs to the record
// rather than user input. The separate view prevents clients setting it.
type subscriptionOriginRecord struct {
	subscriptionOriginState
	ProofRevision uint64 `json:"proofRevision"`
}

type subscriptionOriginView struct {
	subscriptionOriginState
	DefaultOrigin       string `json:"defaultOrigin"`
	VerificationStatus  string `json:"verificationStatus"`
	CurrentLinkExample  string `json:"currentLinkExample"`
	ProposedLinkExample string `json:"proposedLinkExample"`
	TokensUnchanged     bool   `json:"tokensUnchanged"`
}

func canonicalSubscriptionOrigin(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if len(raw) > 2048 {
		return "", errors.New("subscription origin is too long")
	}
	origin, err := CanonicalPublicOrigin(raw)
	if err != nil {
		return "", errors.New("subscription origin must be HTTPS without credentials, path, query or fragment")
	}
	if err = resources.ValidateHTTPSURL(origin); err != nil {
		return "", errors.New("subscription origin must use a public HTTPS address")
	}
	return origin, nil
}
func (h *server) readSubscriptionOrigin() (subscriptionOriginRecord, any, error) {
	var v subscriptionOriginRecord
	err := h.s.Get("settings", "subscription-origin", &v)
	if errors.Is(err, store.ErrNotFound) {
		return v, nil, nil
	}
	return v, v, err
}
func (h *server) saveSubscriptionOrigin(previous any, v subscriptionOriginRecord) error {
	return h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: "settings", ID: "subscription-origin", Expected: previous}}, []store.RecordWrite{{Kind: "settings", ID: "subscription-origin", Value: v}})
}
func (h *server) subscriptionOriginView(v subscriptionOriginRecord) subscriptionOriginView {
	status := "unverified"
	if v.DraftOrigin == "" {
		status = "not-required"
	} else if v.LastFailure != "" {
		status = "failed"
	} else if v.ProofRevision == v.ConfiguredRevision && v.VerificationExpiresAt != nil {
		if h.subscriptionVerification.now().Before(*v.VerificationExpiresAt) {
			status = "verified"
		} else {
			status = "expired"
		}
	}
	effective := v.EffectiveOrigin
	if effective == "" {
		effective = h.opts.PublicOrigin
	}
	proposed := v.DraftOrigin
	if proposed == "" {
		proposed = h.opts.PublicOrigin
	}
	return subscriptionOriginView{subscriptionOriginState: v.subscriptionOriginState, DefaultOrigin: h.opts.PublicOrigin, VerificationStatus: status, CurrentLinkExample: effective + "/feed/{existing-token}", ProposedLinkExample: proposed + "/feed/{existing-token}", TokensUnchanged: true}
}
func (h *server) registerSubscriptionOriginAdmin(r chi.Router) {
	const path = "/admin/subscription-origin"
	r.Get(path, func(w http.ResponseWriter, r *http.Request) {
		v, _, err := h.readSubscriptionOrigin()
		if err != nil {
			fail(w, 500, "cannot read subscription origin")
			return
		}
		writeJSON(w, 200, h.subscriptionOriginView(v))
	})
	r.Put(path, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Origin           string `json:"origin"`
			ExpectedRevision uint64 `json:"expectedRevision"`
		}
		if !decode(w, r, &in) {
			return
		}
		origin, err := canonicalSubscriptionOrigin(in.Origin)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		v, previous, err := h.readSubscriptionOrigin()
		if err != nil {
			fail(w, 500, "cannot read subscription origin")
			return
		}
		if in.ExpectedRevision != v.Revision {
			fail(w, 409, "settings changed; reload before saving")
			return
		}
		v.Revision++
		v.ConfiguredRevision = v.Revision
		v.DraftOrigin = origin
		v.ProofRevision = 0
		v.VerifiedAt = nil
		v.VerificationExpiresAt = nil
		v.LastFailure = ""
		if err = h.saveSubscriptionOrigin(previous, v); err != nil {
			storeError(w, err)
			return
		}
		h.s.Audit(current(r).Account.ID, "subscription-origin.staged", "subscription-origin")
		writeJSON(w, 200, h.subscriptionOriginView(v))
	})
	r.Post(path+"/verify", h.verifySubscriptionOrigin)
	r.Post(path+"/activate", h.activateSubscriptionOrigin)
}

func (h *server) reviewedSubscriptionOrigin(w http.ResponseWriter, r *http.Request) (subscriptionOriginRecord, any, bool) {
	var in struct {
		ExpectedRevision uint64 `json:"expectedRevision"`
	}
	if !decode(w, r, &in) {
		return subscriptionOriginRecord{}, nil, false
	}
	v, previous, err := h.readSubscriptionOrigin()
	if err != nil {
		fail(w, 500, "cannot read subscription origin")
		return v, nil, false
	}
	if in.ExpectedRevision != v.Revision || v.ConfiguredRevision == 0 {
		fail(w, 409, "settings changed or no draft exists; reload before continuing")
		return v, nil, false
	}
	return v, previous, true
}
func (h *server) verifySubscriptionOrigin(w http.ResponseWriter, r *http.Request) {
	v, previous, ok := h.reviewedSubscriptionOrigin(w, r)
	if !ok {
		return
	}
	if v.DraftOrigin == "" {
		fail(w, 400, "the default link origin does not require a custom-domain probe")
		return
	}
	err := h.subscriptionVerification.verify(r.Context(), v.DraftOrigin)
	now := h.subscriptionVerification.now().UTC()
	v.Revision++
	v.ProofRevision = 0
	v.VerifiedAt = nil
	v.VerificationExpiresAt = nil
	if err != nil {
		v.LastFailure = "Could not verify this instance. Check public DNS, the HTTPS certificate and /feed routing, then verify again."
	} else {
		expiry := now.Add(5 * time.Minute)
		v.ProofRevision = v.ConfiguredRevision
		v.VerifiedAt = &now
		v.VerificationExpiresAt = &expiry
		v.LastFailure = ""
	}
	if saveErr := h.saveSubscriptionOrigin(previous, v); saveErr != nil {
		storeError(w, saveErr)
		return
	}
	action := "subscription-origin.verified"
	if err != nil {
		action = "subscription-origin.verification-failed"
	}
	h.s.Audit(current(r).Account.ID, action, "subscription-origin")
	if err != nil {
		fail(w, 422, v.LastFailure)
		return
	}
	writeJSON(w, 200, h.subscriptionOriginView(v))
}
func (h *server) activateSubscriptionOrigin(w http.ResponseWriter, r *http.Request) {
	v, previous, ok := h.reviewedSubscriptionOrigin(w, r)
	if !ok {
		return
	}
	now := h.subscriptionVerification.now().UTC()
	if v.DraftOrigin != "" && (v.ProofRevision != v.ConfiguredRevision || v.VerificationExpiresAt == nil || !now.Before(*v.VerificationExpiresAt) || v.LastFailure != "") {
		fail(w, 409, "verify the saved draft again before activating; verification expires after five minutes")
		return
	}
	v.Revision++
	v.EffectiveOrigin = v.DraftOrigin
	v.EffectiveRevision = v.ConfiguredRevision
	v.ActivatedAt = &now
	if err := h.saveSubscriptionOrigin(previous, v); err != nil {
		storeError(w, err)
		return
	}
	h.s.Audit(current(r).Account.ID, "subscription-origin.activated", "subscription-origin")
	writeJSON(w, 200, h.subscriptionOriginView(v))
}

// An empty result intentionally means a relative same-origin link. Never derive
// an absolute credential-bearing URL from Host or forwarded request headers.
func (h *server) effectiveSubscriptionOrigin() (string, error) {
	v, _, err := h.readSubscriptionOrigin()
	if err != nil {
		return "", err
	}
	if v.EffectiveOrigin == "" {
		return h.opts.PublicOrigin, nil
	}
	origin, err := canonicalSubscriptionOrigin(v.EffectiveOrigin)
	if err != nil || origin != v.EffectiveOrigin {
		return "", errors.New("invalid effective subscription origin")
	}
	return origin, nil
}
func (h *server) writeOutputAccess(w http.ResponseWriter, v Output) {
	origin, err := h.effectiveSubscriptionOrigin()
	if err != nil {
		fail(w, 500, "cannot read effective subscription origin")
		return
	}
	path := "/feed/" + v.Token
	delivery := "feed"
	if len(v.ResourceFiles) > 0 {
		delivery = "bundle"
	}
	writeJSON(w, 200, map[string]string{"feedPath": path, "feedURL": origin + path, "bundlePath": path + "/bundle", "bundleURL": origin + path + "/bundle", "downloadPath": "/api/me/outputs/" + v.ID + "/bundle", "delivery": delivery})
}
