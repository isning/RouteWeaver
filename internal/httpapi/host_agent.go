package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/auth"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"routeweaver/internal/store"
)

type hostEnrollment struct {
	NodeID          string    `json:"nodeId"`
	EnrollmentEpoch string    `json:"enrollmentEpoch"`
	TokenDigest     string    `json:"tokenDigest"`
	DerivationKey   string    `json:"derivationKey"`
	ExpiresAt       time.Time `json:"expiresAt"`
	Revoked         bool      `json:"revoked"`
}
type hostAgentReceipt struct {
	EnrollmentEpoch string    `json:"enrollmentEpoch"`
	LastSeen        time.Time `json:"lastSeen"`
}

func hostChildToken(parent hostEnrollment, scope controlprotocol.Scope) string {
	mac := hmac.New(sha256.New, []byte(parent.DerivationKey))
	mac.Write([]byte("routeweaver-host-child-v1\x00" + scope.NodeID + "\x00" + scope.InstanceID + "\x00" + scope.EnrollmentEpoch))
	return hex.EncodeToString(mac.Sum(nil))
}
func newHostChild(parent hostEnrollment, instance domain.CoreInstance) (Enrollment, error) {
	epoch, err := auth.Token()
	if err != nil {
		return Enrollment{}, err
	}
	child := Enrollment{Scope: controlprotocol.Scope{NodeID: parent.NodeID, InstanceID: instance.ID, EnrollmentEpoch: "enr_" + epoch}, ExpiresAt: parent.ExpiresAt, HostEnrollmentEpoch: parent.EnrollmentEpoch}
	child.TokenDigest = auth.Digest(hostChildToken(parent, child.Scope))
	return child, nil
}
func (h *server) readHostEnrollment(node string) (hostEnrollment, error) {
	var parent hostEnrollment
	err := h.s.Get("host-enrollments", node, &parent)
	return parent, err
}
func (h *server) hostAgentIdentity(w http.ResponseWriter, r *http.Request) (hostEnrollment, bool) {
	var parent, latest hostEnrollment
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		fail(w, 401, "host agent authentication required")
		return parent, false
	}
	digest := auth.Digest(strings.TrimPrefix(header, "Bearer "))
	if h.s.Get("host-agent-enrollments", digest, &parent) != nil || parent.TokenDigest != digest || parent.Revoked || !time.Now().Before(parent.ExpiresAt) || parent.NodeID != chi.URLParam(r, "nodeId") || parent.NodeID != r.Header.Get("X-RouteWeaver-Node") || parent.EnrollmentEpoch != r.Header.Get("X-RouteWeaver-Enrollment") {
		fail(w, 401, "host agent enrollment invalid or expired")
		return parent, false
	}
	var host domain.Host
	if h.s.Get("hosts", parent.NodeID, &host) != nil || h.s.Get("host-enrollments", parent.NodeID, &latest) != nil || latest != parent {
		fail(w, 401, "host agent enrollment superseded")
		return parent, false
	}
	return parent, true
}

// Replaces one host authority and all of its child credentials atomically. The
// inventory and enrollment membership fences prevent concurrent cores escaping revocation.
func (h *server) replaceHostEnrollment(node string, expires time.Time, revoke bool) (hostEnrollment, string, error) {
	proof := preparedFleet{}
	var host domain.Host
	if err := h.fleetRead(&proof, "hosts", node, &host, false); err != nil {
		return hostEnrollment{}, "", err
	}
	var previous hostEnrollment
	if err := h.fleetRead(&proof, "host-enrollments", node, &previous, true); err != nil {
		return hostEnrollment{}, "", err
	}
	instances, err := h.fleetList(&proof, "core-instances")
	if err != nil {
		return hostEnrollment{}, "", err
	}
	enrollments, err := h.hostChildEnrollments(&proof)
	if err != nil {
		return hostEnrollment{}, "", err
	}
	token, err := auth.Token()
	if err != nil {
		return hostEnrollment{}, "", err
	}
	epoch, err := auth.Token()
	if err != nil {
		return hostEnrollment{}, "", err
	}
	key, err := auth.Token()
	if err != nil {
		return hostEnrollment{}, "", err
	}
	next := hostEnrollment{NodeID: node, EnrollmentEpoch: "host_" + epoch, TokenDigest: auth.Digest(token), DerivationKey: key, ExpiresAt: expires}
	writes := []store.RecordWrite{}
	if previous.NodeID != "" {
		previous.Revoked = true
		writes = append(writes, store.RecordWrite{Kind: "host-agent-enrollments", ID: previous.TokenDigest, Value: previous})
	}
	for _, raw := range enrollments {
		var old Enrollment
		if json.Unmarshal(raw, &old) != nil {
			return next, "", errors.New("invalid instance enrollment")
		}
		if old.Scope.NodeID != node {
			continue
		}
		old.Revoked = true
		writes = append(writes, store.RecordWrite{Kind: "instance-enrollments", ID: old.Scope.InstanceID, Value: old}, store.RecordWrite{Kind: "agent-enrollments", ID: old.TokenDigest, Value: old})
	}
	count := 0
	for _, raw := range instances {
		var instance domain.CoreInstance
		if json.Unmarshal(raw, &instance) != nil {
			return next, "", errors.New("invalid core inventory")
		}
		if instance.HostID != node {
			continue
		}
		count++
		if count > controlprotocol.MaxHostInstances {
			return next, "", errors.New("host core limit exceeded")
		}
		if !revoke {
			child, e := newHostChild(next, instance)
			if e != nil {
				return next, "", e
			}
			writes = append(writes, store.RecordWrite{Kind: "instance-enrollments", ID: instance.ID, Value: child}, store.RecordWrite{Kind: "agent-enrollments", ID: child.TokenDigest, Value: child})
		}
	}
	if revoke {
		if previous.NodeID == "" {
			return next, "", store.ErrNotFound
		}
		next = previous
		next.Revoked = true
		token = ""
	} else {
		writes = append(writes, store.RecordWrite{Kind: "host-agent-enrollments", ID: next.TokenDigest, Value: next})
	}
	writes = append(writes, store.RecordWrite{Kind: "host-enrollments", ID: node, Value: next})
	if !revoke {
		var observation observability.State
		if err := h.fleetRead(&proof, "node-observability", node, &observation, true); err != nil {
			return next, "", err
		}
		config := observation.Config
		config.ObserverKind = "host-agent"
		config.ObserverInstanceID = ""
		changed := observation.Config.ObserverKind != "host-agent" || observation.Config.ObserverInstanceID != ""
		migrated, err := observability.Configure(observation, config)
		if err != nil {
			return next, "", err
		}
		writes = append(writes, store.RecordWrite{Kind: "node-observability", ID: node, Value: migrated})
		if changed {
			for _, kind := range []string{"node-resource-history", "node-resource-hourly"} {
				var history json.RawMessage
				if err := h.fleetRead(&proof, kind, node, &history, true); err != nil {
					return next, "", err
				}
				if len(history) > 0 {
					writes = append(writes, store.RecordWrite{Kind: kind, ID: node, Value: observability.ResourceHistory{}})
				}
			}
		}
	}
	err = h.s.CompareSetsAndPutRecords(proof.Compares, proof.Sets, writes)
	return next, token, err
}

func (h *server) registerHostAgent(r chi.Router) {
	r.Post("/agent/hosts/{nodeId}/node-observations", func(w http.ResponseWriter, r *http.Request) {
		parent, ok := h.hostAgentIdentity(w, r)
		if !ok {
			return
		}
		var report observability.Report
		if !decode(w, r, &report) {
			return
		}
		if !report.HostAgent || report.Scope.NodeID != parent.NodeID || report.Scope.EnrollmentEpoch != parent.EnrollmentEpoch || report.Scope.InstanceID != "" {
			fail(w, 403, "host observation scope mismatch")
			return
		}
		receipt, err := h.s.AcceptNodeObservation(report, time.Now().UTC())
		if err != nil {
			nodeObservationError(w, err)
			return
		}
		writeJSON(w, 200, receipt)
	})
	r.Get("/agent/hosts/{nodeId}/assignments", func(w http.ResponseWriter, r *http.Request) {
		parent, ok := h.hostAgentIdentity(w, r)
		if !ok {
			return
		}
		proof := preparedFleet{}
		var current hostEnrollment
		if err := h.fleetRead(&proof, "host-enrollments", parent.NodeID, &current, false); err != nil || current != parent {
			fail(w, 401, "host agent enrollment superseded")
			return
		}
		records, err := h.fleetList(&proof, "core-instances")
		if err != nil {
			storeError(w, err)
			return
		}
		assignments := controlprotocol.HostAssignments{NodeID: parent.NodeID, EnrollmentEpoch: parent.EnrollmentEpoch, ExpiresAt: parent.ExpiresAt, Instances: []controlprotocol.HostAssignment{}}
		for _, raw := range records {
			var instance domain.CoreInstance
			if json.Unmarshal(raw, &instance) != nil {
				fail(w, 500, "invalid core inventory")
				return
			}
			if instance.HostID != parent.NodeID {
				continue
			}
			var child Enrollment
			if h.fleetRead(&proof, "instance-enrollments", instance.ID, &child, false) != nil || child.Revoked || child.HostEnrollmentEpoch != parent.EnrollmentEpoch || child.Scope.NodeID != parent.NodeID || child.Scope.InstanceID != instance.ID || !time.Now().Before(child.ExpiresAt) {
				fail(w, 409, "core enrollment requires host reconciliation")
				return
			}
			token := hostChildToken(parent, child.Scope)
			if auth.Digest(token) != child.TokenDigest {
				fail(w, 500, "core enrollment integrity mismatch")
				return
			}
			assignments.Instances = append(assignments.Instances, controlprotocol.HostAssignment{Instance: instance, Scope: child.Scope, Token: token})
		}
		if len(assignments.Instances) > controlprotocol.MaxHostInstances {
			fail(w, 409, "host core limit exceeded")
			return
		}
		sort.Slice(assignments.Instances, func(i, j int) bool {
			return assignments.Instances[i].Instance.ID < assignments.Instances[j].Instance.ID
		})
		receipt := hostAgentReceipt{EnrollmentEpoch: parent.EnrollmentEpoch, LastSeen: time.Now().UTC()}
		if err = h.s.CompareSetsAndPutRecords(proof.Compares, proof.Sets, []store.RecordWrite{{Kind: "host-agent-receipts", ID: parent.NodeID, Value: receipt}}); err != nil {
			storeError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, assignments)
	})
}
func (h *server) registerHostAgentAdmin(r chi.Router) {
	h.registerHostCoreInstall(r)
	r.Post("/agent/hosts/enrollments", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			NodeID    string    `json:"nodeId"`
			ExpiresAt time.Time `json:"expiresAt"`
		}
		if !decode(w, r, &in) {
			return
		}
		if !domain.ValidID(in.NodeID) || !in.ExpiresAt.After(time.Now()) || in.ExpiresAt.After(time.Now().Add(365*24*time.Hour)) {
			fail(w, 400, "valid host and expiry within one year required")
			return
		}
		enrollment, token, err := h.replaceHostEnrollment(in.NodeID, in.ExpiresAt, false)
		if err != nil {
			storeError(w, err)
			return
		}
		h.s.Audit(current(r).Account.ID, "host-agent.enrolled", in.NodeID)
		writeJSON(w, 201, map[string]any{"scope": map[string]string{"nodeId": in.NodeID, "enrollmentEpoch": enrollment.EnrollmentEpoch}, "token": token, "expiresAt": enrollment.ExpiresAt})
	})
	r.Post("/agent/hosts/{nodeId}/revoke", func(w http.ResponseWriter, r *http.Request) {
		_, _, err := h.replaceHostEnrollment(chi.URLParam(r, "nodeId"), time.Now(), true)
		if err != nil {
			storeError(w, err)
			return
		}
		h.s.Audit(current(r).Account.ID, "host-agent.revoked", chi.URLParam(r, "nodeId"))
		writeJSON(w, 200, map[string]bool{"revoked": true})
	})
	r.Get("/agent/hosts/{nodeId}/state", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "nodeId")
		var host domain.Host
		if err := h.s.Get("hosts", id, &host); err != nil {
			storeError(w, err)
			return
		}
		parent, err := h.readHostEnrollment(id)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			storeError(w, err)
			return
		}
		view := map[string]any{"nodeId": id, "phase": "unregistered"}
		if parent.NodeID != "" {
			phase := "awaiting-agent"
			if parent.Revoked {
				phase = "revoked"
			} else if !time.Now().Before(parent.ExpiresAt) {
				phase = "expired"
			} else {
				var receipt hostAgentReceipt
				if h.s.Get("host-agent-receipts", id, &receipt) == nil && receipt.EnrollmentEpoch == parent.EnrollmentEpoch {
					view["lastSeen"] = receipt.LastSeen
					phase = "offline"
					if age := time.Since(receipt.LastSeen); age >= 0 && age < 35*time.Second {
						phase = "online"
					}
				}
			}
			view["phase"] = phase
			view["expiresAt"] = parent.ExpiresAt
		}
		writeJSON(w, 200, view)
	})
}

// Server-owned core bindings inherit the one host agent authority. Existing
// instance scopes remain independent for generation, recovery and accounting.
func (h *server) saveHostCore(instance domain.CoreInstance) error {
	proof := preparedFleet{}
	var host domain.Host
	if err := h.fleetRead(&proof, "hosts", instance.HostID, &host, false); err != nil {
		return err
	}
	var previous domain.CoreInstance
	if err := h.fleetRead(&proof, "core-instances", instance.ID, &previous, true); err != nil {
		return err
	}
	var parent hostEnrollment
	if err := h.fleetRead(&proof, "host-enrollments", instance.HostID, &parent, true); err != nil {
		return err
	}
	var child Enrollment
	if err := h.fleetRead(&proof, "instance-enrollments", instance.ID, &child, true); err != nil {
		return err
	}
	writes := []store.RecordWrite{{Kind: "core-instances", ID: instance.ID, Value: instance}}
	active := parent.NodeID == instance.HostID && !parent.Revoked && time.Now().Before(parent.ExpiresAt)
	if child.Scope.InstanceID != "" && (child.Scope.NodeID != instance.HostID || (active && child.HostEnrollmentEpoch != parent.EnrollmentEpoch)) {
		child.Revoked = true
		writes = append(writes, store.RecordWrite{Kind: "agent-enrollments", ID: child.TokenDigest, Value: child}, store.RecordWrite{Kind: "instance-enrollments", ID: instance.ID, Value: child})
	}
	if active && (child.Scope.InstanceID == "" || child.Revoked || child.HostEnrollmentEpoch != parent.EnrollmentEpoch) {
		records, err := h.fleetList(&proof, "core-instances")
		if err != nil {
			return err
		}
		count := 1
		for _, raw := range records {
			var other domain.CoreInstance
			if json.Unmarshal(raw, &other) != nil {
				return fmt.Errorf("invalid core inventory")
			}
			if other.HostID == instance.HostID && other.ID != instance.ID {
				count++
			}
		}
		if count > controlprotocol.MaxHostInstances {
			return fmt.Errorf("host core limit exceeded")
		}
		next, err := newHostChild(parent, instance)
		if err != nil {
			return err
		}
		writes = append(writes, store.RecordWrite{Kind: "instance-enrollments", ID: instance.ID, Value: next}, store.RecordWrite{Kind: "agent-enrollments", ID: next.TokenDigest, Value: next})
	}
	return h.s.CompareSetsAndPutRecords(proof.Compares, proof.Sets, writes)
}

func (h *server) hostChildEnrollments(proof *preparedFleet) ([]json.RawMessage, error) {
	records, err := h.s.List("instance-enrollments")
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, raw := range records {
		var child Enrollment
		if json.Unmarshal(raw, &child) != nil || !domain.ValidID(child.Scope.InstanceID) {
			return nil, errors.New("invalid instance enrollment")
		}
		ids = append(ids, child.Scope.InstanceID)
		proof.Compares = append(proof.Compares, store.RecordCompare{Kind: "instance-enrollments", ID: child.Scope.InstanceID, Expected: raw})
	}
	proof.Sets = append(proof.Sets, store.RecordSetCompare{Kind: "instance-enrollments", IDs: ids})
	return records, nil
}
