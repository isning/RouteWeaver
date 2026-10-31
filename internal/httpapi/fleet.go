package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/auth"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/fleet"
	"routeweaver/internal/store"
)

func (h *server) registerFleetAdmin(r chi.Router) {
	r.Get("/admin/core-releases", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, controlprotocol.OfficialCoreReleases())
	})
	r.Post("/admin/fleet-batches/preview", func(w http.ResponseWriter, r *http.Request) {
		var in fleet.Input
		if !decode(w, r, &in) {
			return
		}
		p, e := h.prepareFleet(in)
		if e != nil {
			var ownership *ownershipConflict
			if errors.As(e, &ownership) {
				fail(w, 409, e.Error())
			} else {
				fail(w, 422, e.Error())
			}
			return
		}
		writeJSON(w, 200, p.Plan)
	})
	r.Post("/admin/fleet-batches", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			fleet.Input
			ExpectedFingerprint string `json:"expectedFingerprint"`
			LeaseSeconds        int    `json:"leaseSeconds"`
		}
		if !decode(w, r, &in) {
			return
		}
		if in.LeaseSeconds < 30 || in.LeaseSeconds > 3600 {
			fail(w, 400, "explicit policy lease must be 30–3600 seconds")
			return
		}
		p, e := h.prepareFleet(in.Input)
		if e != nil {
			var ownership *ownershipConflict
			if errors.As(e, &ownership) {
				fail(w, 409, e.Error())
			} else {
				fail(w, 422, e.Error())
			}
			return
		}
		if in.ExpectedFingerprint == "" || in.ExpectedFingerprint != p.Plan.Fingerprint {
			writeJSON(w, 409, map[string]string{
				"detail": "plan inputs changed; preview again before creating the batch",
				"code":   "FLEET_REVIEW_CHANGED",
			})
			return
		}
		if !p.Plan.Supported {
			writeJSON(w, 422, map[string]any{"detail": "one or more targets cannot perform this action", "plan": p.Plan})
			return
		}
		token, e := auth.Token()
		if e != nil {
			storeError(w, e)
			return
		}
		record := fleetRecord{Transitions: p.Transitions, Batch: fleet.Batch{ID: "batch_" + token, Plan: p.Plan, ActorID: current(r).Account.ID, CreatedAt: time.Now().UTC(), LeaseSeconds: in.LeaseSeconds, Status: "planned"}, Deployment: p.Deployment, Baselines: map[string]*controlprotocol.Identity{}, Enrollments: p.Enrollments, AuthorizationHash: p.AuthorizationHash, Requests: map[string]string{}}
		for id, d := range p.Baselines {
			identity := d.Identity()
			record.Baselines[id] = &identity
		}
		p.Compares = append(p.Compares, store.RecordCompare{Kind: "fleet-batches", ID: record.Batch.ID})
		if e = h.s.CompareSetsAndPutRecords(p.Compares, p.Sets, []store.RecordWrite{{Kind: "fleet-batches", ID: record.Batch.ID, Value: record}}); e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 201, record.Batch)
	})
	r.Get("/admin/fleet-batches", func(w http.ResponseWriter, r *http.Request) {
		records, e := h.s.List("fleet-batches")
		if e != nil {
			storeError(w, e)
			return
		}
		out := []fleet.Batch{}
		for _, raw := range records {
			var record fleetRecord
			if e = json.Unmarshal(raw, &record); e != nil {
				storeError(w, e)
				return
			}
			batch, e := h.fleetView(record)
			if e != nil {
				storeError(w, e)
				return
			}
			out = append(out, batch)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
		writeJSON(w, 200, out)
	})
	r.Get("/admin/fleet-batches/{id}", func(w http.ResponseWriter, r *http.Request) {
		var record fleetRecord
		if e := h.s.Get("fleet-batches", chi.URLParam(r, "id"), &record); e != nil {
			storeError(w, e)
			return
		}
		batch, e := h.fleetView(record)
		if e != nil {
			storeError(w, e)
			return
		}
		writeJSON(w, 200, batch)
	})
	r.Post("/admin/fleet-batches/{id}/execute", h.executeFleet(false))
	r.Post("/admin/fleet-batches/{id}/retry", h.executeFleet(true))
}
func (h *server) fleetView(record fleetRecord) (fleet.Batch, error) {
	// Work on a deep copy: an observational GET cannot change the stored plan.
	raw, _ := json.Marshal(record.Batch)
	var batch fleet.Batch
	json.Unmarshal(raw, &batch)
	for i := range batch.Targets {
		target := &batch.Targets[i]
		for n := range target.Attempts {
			attempt := target.Attempts[n]
			if attempt.Identity == nil {
				continue
			}
			var state controlprotocol.State
			e := h.s.Get("agent-operation-observations", attempt.Identity.OperationID, &state)
			if e != nil && e != store.ErrNotFound {
				return batch, e
			}
			var observation *controlprotocol.State
			if e == nil {
				observation = &state
			}
			target.Attempts[n] = fleet.Outcome(batch.Action, attempt, observation, time.Now().UTC())
			if target.Attempts[n].Status == "succeeded" && target.Attempts[n].ObservedAt == nil {
				var at time.Time
				if h.s.Get("agent-operation-received", attempt.Identity.OperationID, &at) == nil {
					target.Attempts[n].ObservedAt = &at
				}
			}
			if n == len(target.Attempts)-1 && target.Attempts[n].Status != "succeeded" && target.Attempts[n].Status != "failed" {
				var desired controlprotocol.Desired
				if h.s.Get("agent-desired", target.InstanceID, &desired) == nil && desired.Identity() != *attempt.Identity {
					target.Attempts[n].Status = "superseded"
					target.Attempts[n].Code = "desired_superseded_review_required"
				}
			}
		}
		if len(target.Attempts) > 0 {
			target.Status = target.Attempts[len(target.Attempts)-1].Status
		}
	}
	batch.Status = fleet.Status(batch.Targets)
	return batch, nil
}
func fleetTarget(record *fleetRecord, id string) (*fleet.Target, error) {
	for i := range record.Batch.Targets {
		if record.Batch.Targets[i].InstanceID == id {
			return &record.Batch.Targets[i], nil
		}
	}
	return nil, fmt.Errorf("target is not part of this batch")
}
