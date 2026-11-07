package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"routeweaver/internal/domain"
)

var (
	errFleetCreationPrecondition = errors.New("fleet creation requires a valid id and a single If-None-Match: * precondition")
	errFleetCreationConflict     = errors.New("batch ID already exists; retrieve it before deciding how to continue")
)

func (h *server) fleetCreationID(r *http.Request, raw json.RawMessage) (string, error) {
	conditions, supplied := r.Header["If-None-Match"]
	if _, matched := r.Header["If-Match"]; matched {
		return "", errFleetCreationPrecondition
	}
	// Only omission of both fields preserves server-generated legacy creation.
	// RawMessage distinguishes omitted IDs from explicit null or empty values.
	if raw == nil && !supplied {
		return "", nil
	}
	var id string
	if !supplied || len(conditions) != 1 || strings.Trim(conditions[0], " \t") != "*" || json.Unmarshal(raw, &id) != nil || !domain.ValidID(id) {
		return "", errFleetCreationPrecondition
	}
	// Do not re-plan an occupied ID: dependencies may have changed since the
	// original commit. The existing GET is the explicit recovery path.
	return id, h.fleetCreationAvailable(id)
}

func (h *server) fleetCreationAvailable(id string) error {
	exists, err := h.s.RecordExists("fleet-batches", id)
	if err != nil {
		return err
	}
	if exists {
		return errFleetCreationConflict
	}
	return nil
}

func fleetCreationError(w http.ResponseWriter, err error) {
	if errors.Is(err, errFleetCreationPrecondition) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "FLEET_CREATION_PRECONDITION_INVALID", "detail": errFleetCreationPrecondition.Error()})
		return
	}
	if errors.Is(err, errFleetCreationConflict) {
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{"code": "FLEET_CREATION_CONFLICT", "detail": errFleetCreationConflict.Error()})
		return
	}
	storeError(w, err)
}
