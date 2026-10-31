package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

// A receipt acknowledges this submission, never the current runtime state.
// Its absence is not evidence that an original request cannot still commit.
type publicationIntent struct {
	LeaseSeconds        int    `json:"leaseSeconds"`
	AccessAllowed       bool   `json:"accessAllowed"`
	QuotaCertain        bool   `json:"quotaCertain"`
	ExpectedFingerprint string `json:"expectedFingerprint"`
}
type publicationInput struct {
	OperationID string `json:"operationId"`
	publicationIntent
}
type publicationInstance struct {
	InstanceID  string `json:"instanceId"`
	Generation  string `json:"generation"`
	OperationID string `json:"operationId"`
	RevisionID  string `json:"revisionId"`
}
type publicationResult struct {
	OperationID   string                `json:"operationId"`
	DeploymentID  string                `json:"deploymentId"`
	Status        string                `json:"status"`
	NativeChecked bool                  `json:"nativeChecked"`
	Instances     []publicationInstance `json:"instances,omitempty"`
	Code          string                `json:"code,omitempty"`
	Detail        string                `json:"detail,omitempty"`
}
type publicationReceipt struct {
	Actor        string            `json:"actor"`
	DeploymentID string            `json:"deploymentId"`
	RequestToken string            `json:"requestToken"`
	Request      publicationIntent `json:"request"`
	Result       publicationResult `json:"result"`
}
type publicationAttempt struct {
	actor, deploymentID, operationID, receiptID, token string
	request                                            publicationIntent
}

var publicationFingerprint = regexp.MustCompile(`^[0-9a-f]{64}$`)

func validPublicationIntent(in publicationIntent) bool {
	return in.LeaseSeconds >= 30 && in.LeaseSeconds <= 3600 && publicationFingerprint.MatchString(in.ExpectedFingerprint)
}
func (h *server) newPublicationAttempt(r *http.Request, in publicationInput) (publicationAttempt, error) {
	a := publicationAttempt{actor: current(r).Account.ID, deploymentID: chi.URLParam(r, "id"), operationID: in.OperationID, request: in.publicationIntent}
	a.receiptID = a.actor + ":" + a.operationID
	token, err := h.s.ReviewToken("publication-request/v1/"+a.actor+"/"+a.deploymentID, a.request)
	a.token = token
	return a, err
}
func validPublicationResult(v publicationResult) bool {
	if !domain.ValidID(v.OperationID) || !domain.ValidID(v.DeploymentID) || v.NativeChecked {
		return false
	}
	switch v.Status {
	case "publication-accepted":
		if len(v.Instances) == 0 || v.Code != "" || v.Detail != "" {
			return false
		}
		seen := map[string]bool{}
		for _, p := range v.Instances {
			n, err := strconv.ParseInt(p.Generation, 10, 64)
			if err != nil || n <= 0 || strconv.FormatInt(n, 10) != p.Generation || !domain.ValidID(p.InstanceID) || !domain.ValidID(p.OperationID) || !domain.ValidID(p.RevisionID) || seen[p.InstanceID] {
				return false
			}
			seen[p.InstanceID] = true
		}
		return true
	case "definitively-rejected":
		return len(v.Instances) == 0 && (v.Code == "SERVER_DRAFT_CHANGED" || v.Code == "PUBLICATION_REJECTED") && v.Detail != ""
	}
	return false
}
func (h *server) readPublicationReceipt(actor, deploymentID, operationID string) (publicationReceipt, error) {
	var receipt publicationReceipt
	err := h.s.Get("publication-receipts", actor+":"+operationID, &receipt)
	if err != nil {
		return receipt, err
	}
	if receipt.Actor != actor || receipt.DeploymentID != deploymentID {
		return publicationReceipt{}, store.ErrNotFound
	}
	if receipt.Result.OperationID != operationID || receipt.Result.DeploymentID != deploymentID || !validPublicationIntent(receipt.Request) || !validPublicationResult(receipt.Result) {
		return publicationReceipt{}, fmt.Errorf("invalid publication receipt")
	}
	token, err := h.s.ReviewToken("publication-request/v1/"+actor+"/"+deploymentID, receipt.Request)
	if err != nil {
		return publicationReceipt{}, err
	}
	if !sameReviewToken(token, receipt.RequestToken) {
		return publicationReceipt{}, fmt.Errorf("invalid publication receipt binding")
	}
	return receipt, nil
}
func (h *server) lookupPublicationRequest(w http.ResponseWriter, r *http.Request) {
	id, op := chi.URLParam(r, "id"), chi.URLParam(r, "operationId")
	if !domain.ValidID(id) || !domain.ValidID(op) {
		fail(w, 400, "invalid publication request identity")
		return
	}
	receipt, err := h.readPublicationReceipt(current(r).Account.ID, id, op)
	if err != nil {
		writePublicationOperationalError(w, err)
		return
	}
	writeJSON(w, 200, struct {
		Request publicationIntent `json:"request"`
		Result  publicationResult `json:"result"`
	}{receipt.Request, receipt.Result})
}

// Return handled even for a mismatched occupied identity: it cannot be reused.
func (h *server) replayPublication(w http.ResponseWriter, a publicationAttempt) bool {
	var stored publicationReceipt
	err := h.s.Get("publication-receipts", a.receiptID, &stored)
	if err == store.ErrNotFound {
		return false
	}
	if err != nil {
		writePublicationOperationalError(w, err)
		return true
	}
	if stored.Actor != a.actor || stored.DeploymentID != a.deploymentID || !sameReviewToken(stored.RequestToken, a.token) {
		writeJSON(w, 409, map[string]any{"code": "PUBLICATION_OPERATION_REUSED", "detail": "This submission identity belongs to a different request; recover the original request before reviewing another submission."})
		return true
	}
	receipt, err := h.readPublicationReceipt(a.actor, a.deploymentID, a.operationID)
	if err != nil {
		writePublicationOperationalError(w, err)
		return true
	}
	writeJSON(w, 200, receipt.Result)
	return true
}
func (a publicationAttempt) receipt(result publicationResult) publicationReceipt {
	return publicationReceipt{Actor: a.actor, DeploymentID: a.deploymentID, RequestToken: a.token, Request: a.request, Result: result}
}

// Only call with a completed domain refusal, never an operational error/status.
func (h *server) rejectPublication(w http.ResponseWriter, a publicationAttempt, code, detail string) {
	if h.replayPublication(w, a) {
		return
	}
	result := publicationResult{OperationID: a.operationID, DeploymentID: a.deploymentID, Status: "definitively-rejected", Code: code, Detail: detail}
	err := h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: "publication-receipts", ID: a.receiptID}}, []store.RecordWrite{{Kind: "publication-receipts", ID: a.receiptID, Value: a.receipt(result)}})
	if err != nil {
		if h.replayPublication(w, a) {
			return
		}
		writePublicationOperationalError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
func writePublicationOperationalError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		fail(w, 404, "No result has been found for this submission.")
		return
	}
	fail(w, 503, "The submission result could not be confirmed; recover this same submission before trying another.")
}

// Marks only a proven pure validation refusal while retaining existing callers'
// error text. Receipt detail is separately allowlisted, never copied from cause.
type publicationRefusal struct {
	cause  error
	detail string
}

func (e *publicationRefusal) Error() string { return e.cause.Error() }
func (e *publicationRefusal) Unwrap() error { return e.cause }
func publicationDomainError(detail, format string, args ...any) error {
	return &publicationRefusal{cause: fmt.Errorf(format, args...), detail: detail}
}
