package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"net/http"
	"routeweaver/internal/auth"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"strconv"
	"strings"
	"time"
)

type Enrollment struct {
	Scope       controlprotocol.Scope `json:"scope"`
	TokenDigest string                `json:"tokenDigest"`
	ExpiresAt   time.Time             `json:"expiresAt"`
	Revoked     bool                  `json:"revoked"`
}

func (h *server) agentIdentity(w http.ResponseWriter, r *http.Request) (Enrollment, bool) {
	var e Enrollment
	bearer := r.Header.Get("Authorization")
	if !strings.HasPrefix(bearer, "Bearer ") {
		fail(w, 401, "agent authentication required")
		return e, false
	}
	digest := auth.Digest(strings.TrimPrefix(bearer, "Bearer "))
	if err := h.s.Get("agent-enrollments", digest, &e); err != nil || e.Revoked || !time.Now().Before(e.ExpiresAt) || e.TokenDigest != digest || e.Scope.InstanceID != chi.URLParam(r, "instanceId") || e.Scope.NodeID != r.Header.Get("X-RouteWeaver-Node") || e.Scope.EnrollmentEpoch != r.Header.Get("X-RouteWeaver-Enrollment") {
		fail(w, 401, "agent scope invalid or expired")
		return e, false
	}
	var latest Enrollment
	if err := h.s.Get("instance-enrollments", e.Scope.InstanceID, &latest); err != nil || latest.Scope != e.Scope || latest.Revoked || latest.TokenDigest != digest {
		fail(w, 401, "agent enrollment superseded")
		return e, false
	}
	return e, true
}
func (h *server) registerAgent(r chi.Router) {
	h.registerDiagnosticAgent(r)
	h.registerCoreDiagnosticAgent(r)
	h.registerRawCoreLogAgent(r)
	h.registerNodeObservationAgent(r)
	h.registerAdmissionAgent(r)
	h.registerServiceHeartbeat(r)
	r.Get("/agent/instances/{instanceId}/desired", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		var v controlprotocol.Desired
		if e := h.s.Get("agent-desired", enrollment.Scope.InstanceID, &v); e == store.ErrNotFound {
			w.WriteHeader(204)
			return
		} else if e != nil {
			fail(w, 500, "cannot read desired state")
			return
		}
		if v.Scope != enrollment.Scope {
			fail(w, 409, "desired state belongs to another enrollment")
			return
		}
		after, e := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
		if r.URL.Query().Get("after") == "" {
			after = 0
			e = nil
		}
		if e != nil {
			fail(w, 400, "invalid generation")
			return
		}
		if v.Generation <= after {
			w.WriteHeader(204)
			return
		}
		writeJSON(w, 200, v)
	})
	r.Post("/agent/instances/{instanceId}/observations", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		var state controlprotocol.State
		if !decode(w, r, &state) {
			return
		}
		if state.Desired == nil || state.Desired.Scope != enrollment.Scope || state.Observed != nil && state.Observed.Scope != enrollment.Scope || state.LastKnownValid != nil && state.LastKnownValid.Scope != enrollment.Scope {
			fail(w, 403, "observation scope mismatch")
			return
		}
		var desired controlprotocol.Desired
		if e := h.s.Get("agent-desired", enrollment.Scope.InstanceID, &desired); e != nil {
			fail(w, 409, "no accepted desired state")
			return
		}
		if *state.Desired != desired.Identity() {
			fail(w, 409, "observation does not match current desired generation")
			return
		}
		if state.Phase == controlprotocol.ObservedConformant && (state.Observed == nil || !state.Observed.Known || state.Observed.Identity != desired.Identity()) {
			fail(w, 400, "conformant phase requires matching observation")
			return
		}
		if e := h.recordAgentObservation(desired, enrollment, state); e != nil {
			if errors.Is(e, store.ErrConflict) {
				fail(w, 409, "observation is stale or conflicts with current state")
				return
			}
			fail(w, 500, "cannot persist observation")
			return
		}
		w.WriteHeader(204)
	})
	r.Post("/agent/instances/{instanceId}/meter-batches", func(w http.ResponseWriter, r *http.Request) {
		enrollment, ok := h.agentIdentity(w, r)
		if !ok {
			return
		}
		var batch controlprotocol.MeterBatch
		if !decode(w, r, &batch) {
			return
		}
		if batch.Scope != enrollment.Scope || batch.Sequence == 0 || (len(batch.Samples) == 0 && batch.TerminalEvidence == nil) || len(batch.Samples) > 1000 || len(batch.StreamEpoch) > 128 || strings.ContainsAny(batch.StreamEpoch, ":/\\") || batch.StreamEpoch == "" {
			fail(w, 400, "invalid meter envelope")
			return
		}
		digest := batch.Digest
		batch.Digest = ""
		raw, _ := json.Marshal(batch)
		sum := sha256.Sum256(raw)
		batch.Digest = digest
		if digest != hex.EncodeToString(sum[:]) {
			fail(w, 400, "meter digest mismatch")
			return
		}
		counterBatch := store.CounterBatch{InstanceID: batch.Scope.InstanceID, EnrollmentEpoch: batch.Scope.EnrollmentEpoch, StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, Digest: batch.Digest, TerminalEvidence: batch.TerminalEvidence}
		for _, sample := range batch.Samples {
			counterBatch.Samples = append(counterBatch.Samples, store.CounterSample{LedgerMode: sample.LedgerMode, SampleID: sample.SampleID, CounterEpoch: sample.CounterEpoch, SubjectID: sample.SubjectID, RouteID: sample.RouteID, PolicyRevision: sample.PolicyRevision, CycleID: sample.CycleID, MeasurementLayer: sample.MeasurementLayer, CumulativeBytes: sample.CumulativeBytes, ObservedAt: sample.ObservedAt})
		}
		if e := h.s.AcceptCounterBatch(counterBatch, batch); e != nil {
			fail(w, 409, e.Error())
			return
		}
		receipt := controlprotocol.MeterReceipt{StreamEpoch: batch.StreamEpoch, Sequence: batch.Sequence, Digest: batch.Digest}
		if batch.TerminalEvidence != nil {
			receipt.CustodyVersion = 1
			receipt.TerminalEvidenceDigest = batch.TerminalEvidence.Digest
		}
		writeJSON(w, 200, receipt)
	})
}
func (h *server) registerAgentAdmin(r chi.Router) {
	h.registerDiagnosticAdmin(r)
	h.registerAdmissionAdmin(r)
	r.Get("/agent/instances/{instanceId}/meter-terminal-evidence/receipts", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		page, err := h.s.DiscoverMeterTerminalEvidence(r.Context(), chi.URLParam(r, "instanceId"), q.Get("enrollmentEpoch"), q.Get("cursor"))
		if err != nil {
			storeError(w, err)
			return
		}
		writeJSON(w, 200, page)
	})
	r.Get("/agent/instances/{instanceId}/meter-terminal-evidence", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		sequence, err := strconv.ParseUint(q.Get("sequence"), 10, 64)
		if err != nil {
			fail(w, 400, "invalid terminal evidence sequence")
			return
		}
		evidence, err := h.s.MeterTerminalEvidence(chi.URLParam(r, "instanceId"), q.Get("enrollmentEpoch"), q.Get("streamEpoch"), sequence)
		if err != nil {
			storeError(w, err)
			return
		}
		writeJSON(w, 200, evidence)
	})
	r.Get("/agent/instances/{instanceId}/accounting-pending", func(w http.ResponseWriter, r *http.Request) {
		pending, e := h.s.PendingCounterBatches(chi.URLParam(r, "instanceId"))
		if e != nil {
			storeError(w, e)
			return
		}
		// Technical details contain only measured identities and counters, not
		// the raw request or any enrollment token.
		out := []map[string]any{}
		for _, p := range pending {
			out = append(out, map[string]any{"receiptId": p.ReceiptID, "batch": p.Batch, "reason": p.Reason, "createdAt": p.CreatedAt})
		}
		writeJSON(w, 200, out)
	})
	r.Post("/agent/instances/{instanceId}/meter-baseline", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ReceiptID      string `json:"receiptId"`
			ExpectedDigest string `json:"expectedDigest"`
			Reason         string `json:"reason"`
		}
		if !decode(w, r, &in) {
			return
		}
		resolution, e := h.s.EstablishCounterBaseline(chi.URLParam(r, "instanceId"), in.ReceiptID, in.ExpectedDigest, current(r).Account.ID, in.Reason)
		if e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"resolution": resolution, "awaitingBatchReplay": true, "retroactiveCharge": false})
	})
	r.Post("/agent/instances/{instanceId}/meter-bindings", func(w http.ResponseWriter, r *http.Request) {
		var binding store.MeterBinding
		if !decode(w, r, &binding) {
			return
		}
		binding.InstanceID = chi.URLParam(r, "instanceId")
		var instance domain.CoreInstance
		if e := h.s.Get("core-instances", binding.InstanceID, &instance); e != nil {
			storeError(w, e)
			return
		}
		if e := h.s.SetMeterBinding(binding); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 201, binding)
	})

	r.Post("/agent/enrollments", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			NodeID     string    `json:"nodeId"`
			InstanceID string    `json:"instanceId"`
			ExpiresAt  time.Time `json:"expiresAt"`
		}
		if !decode(w, r, &in) {
			return
		}
		if !domain.ValidID(in.NodeID) || !domain.ValidID(in.InstanceID) || !in.ExpiresAt.After(time.Now()) || in.ExpiresAt.After(time.Now().Add(365*24*time.Hour)) {
			fail(w, 400, "valid scope and expiry within one year required")
			return
		}
		var instance domain.CoreInstance
		if e := h.s.Get("core-instances", in.InstanceID, &instance); e != nil || instance.HostID != in.NodeID {
			fail(w, 400, "instance does not belong to this host")
			return
		}
		token, e := auth.Token()
		if e != nil {
			fail(w, 500, "cannot create enrollment")
			return
		}
		epoch, e := auth.Token()
		if e != nil {
			fail(w, 500, "cannot create enrollment")
			return
		}
		v := Enrollment{Scope: controlprotocol.Scope{NodeID: in.NodeID, InstanceID: in.InstanceID, EnrollmentEpoch: "enr_" + epoch}, TokenDigest: auth.Digest(token), ExpiresAt: in.ExpiresAt}
		if e = h.s.UpdateRecords("instance-enrollments", in.InstanceID, func(old json.RawMessage) ([]store.RecordWrite, error) {
			writes := []store.RecordWrite{}
			if len(old) > 0 {
				var previous Enrollment
				if err := json.Unmarshal(old, &previous); err != nil {
					return nil, err
				}
				previous.Revoked = true
				writes = append(writes, store.RecordWrite{Kind: "agent-enrollments", ID: previous.TokenDigest, Value: previous})
			}
			writes = append(writes, store.RecordWrite{Kind: "agent-enrollments", ID: v.TokenDigest, Value: v}, store.RecordWrite{Kind: "instance-enrollments", ID: in.InstanceID, Value: v})
			return writes, nil
		}); e != nil {
			fail(w, 500, "cannot replace enrollment")
			return
		}
		writeJSON(w, 201, map[string]any{"scope": v.Scope, "token": token, "expiresAt": v.ExpiresAt})
	})
	r.Get("/agent/instances/{instanceId}/state", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "instanceId")
		var desired controlprotocol.Desired
		var state controlprotocol.State
		de := h.s.Get("agent-desired", id, &desired)
		se := h.s.Get("agent-observations", id, &state)
		out := map[string]any{"instanceId": id, "phase": "unregistered", "accounting": "verified-bindings-required; accepted-batches-accounted-atomically"}
		if de == nil {
			out["desired"] = desired.Identity()
			out["phase"] = "queued"
		}
		if se == nil {
			out["state"] = state
			if de == nil && state.Desired != nil && state.Desired.Generation == desired.Generation {
				out["phase"] = state.Phase
			} else {
				out["phase"] = "pending-new-generation"
			}
		}
		if view, e := h.serviceIntentView(id, desired.Identity()); e == nil && view != nil {
			out["serviceIntent"] = view
		} else if e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, out)
	})
}
