package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"routeweaver/internal/store"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// Subscription origins only choose generated link addresses. They never alter
// the browser's trusted mutation origin, install TLS, change DNS, or redirect a
// feed credential. A successful probe is a dated observation, not uptime status.
type subscriptionOriginState struct {
	LinkTemplate          string     `json:"linkTemplate"`
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
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if len(raw) > 2048 {
		return "", errors.New("subscription origin is too long")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", errors.New("subscription origin must be an HTTP or HTTPS address without credentials, path, query or fragment")
	}
	origin, err := CanonicalPublicOrigin("https://" + u.Host)
	if err != nil {
		return "", errors.New("invalid subscription address")
	}
	if u.Scheme == "http" {
		origin = "http://" + strings.TrimPrefix(origin, "https://")
		if u.Port() == "443" {
			origin += ":443"
		}
		if u.Port() == "80" {
			origin = strings.TrimSuffix(origin, ":80")
		}
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
	return subscriptionOriginView{subscriptionOriginState: v.subscriptionOriginState, DefaultOrigin: h.opts.PublicOrigin, VerificationStatus: status, CurrentLinkExample: subscriptionTemplateURL(v.LinkTemplate, effective, "{existing-token}", false), ProposedLinkExample: proposed + "/feed/{existing-token}", TokensUnchanged: true}
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
			Origin           string  `json:"origin"`
			LinkTemplate     *string `json:"linkTemplate"`
			ApplyImmediately bool    `json:"applyImmediately"`
			ExpectedRevision uint64  `json:"expectedRevision"`
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
		if in.LinkTemplate != nil {
			if !in.ApplyImmediately {
				fail(w, 400, "save link templates directly")
				return
			}
			template, templateErr := canonicalSubscriptionTemplate(*in.LinkTemplate)
			if templateErr != nil {
				fail(w, 400, templateErr.Error())
				return
			}
			v.LinkTemplate = template
		}
		v.Revision++
		v.ConfiguredRevision = v.Revision
		v.DraftOrigin = origin
		v.ProofRevision = 0
		v.VerifiedAt = nil
		v.VerificationExpiresAt = nil
		v.LastFailure = ""
		if in.ApplyImmediately {
			now := time.Now().UTC()
			v.EffectiveOrigin = origin
			v.EffectiveRevision = v.ConfiguredRevision
			v.ActivatedAt = &now
		}
		if err = h.saveSubscriptionOrigin(previous, v); err != nil {
			storeError(w, err)
			return
		}
		action := "subscription-origin.staged"
		if in.ApplyImmediately {
			action = "subscription-origin.activated"
		}
		h.s.Audit(current(r).Account.ID, action, "subscription-origin")
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
	probeOrigin := v.DraftOrigin
	if v.LinkTemplate != "" {
		u, _ := url.Parse(strings.ReplaceAll(v.LinkTemplate, "{token}", templateMarker))
		probeOrigin = u.Scheme + "://" + u.Host
	}
	if probeOrigin == "" {
		fail(w, 400, "the default link origin does not require a custom-domain probe")
		return
	}
	err := h.subscriptionVerification.verify(r.Context(), probeOrigin)
	now := h.subscriptionVerification.now().UTC()
	v.Revision++
	v.ProofRevision = 0
	v.VerifiedAt = nil
	v.VerificationExpiresAt = nil
	if err != nil {
		v.LastFailure = "Could not verify this instance. Check the subscription address and /feed routing, then try again."
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

func (h *server) writeOutputAccess(w http.ResponseWriter, v Output) {
	record, _, err := h.readSubscriptionOrigin()
	if err != nil {
		fail(w, 500, "cannot read subscription link settings")
		return
	}
	origin := record.EffectiveOrigin
	if origin == "" {
		origin = h.opts.PublicOrigin
	}
	if _, err := canonicalSubscriptionOrigin(origin); err != nil {
		fail(w, 500, "invalid subscription origin")
		return
	}
	if _, err := canonicalSubscriptionTemplate(record.LinkTemplate); err != nil {
		fail(w, 500, "invalid subscription link template")
		return
	}
	feedURL := subscriptionTemplateURL(record.LinkTemplate, origin, v.Token, false)
	bundleURL := subscriptionTemplateURL(record.LinkTemplate, origin, v.Token, true)
	parsed, _ := url.Parse(feedURL)
	bundleParsed, _ := url.Parse(bundleURL)
	path := parsed.RequestURI()
	delivery := "feed"
	if len(v.ResourceFiles) > 0 {
		delivery = "bundle"
	}
	writeJSON(w, 200, map[string]string{"feedPath": path, "feedURL": feedURL, "bundlePath": bundleParsed.RequestURI(), "bundleURL": bundleURL, "downloadPath": "/api/me/outputs/" + v.ID + "/bundle", "delivery": delivery})
}
