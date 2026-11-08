package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/fleet"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
)

type exitChangeInput struct {
	ReplacementEndpointID      string                   `json:"replacementEndpointId"`
	TLS                        *domain.ServerTLSOptions `json:"tls,omitempty"`
	ExpectedRouteRevision      string                   `json:"expectedRouteRevision"`
	ExpectedDeploymentRevision string                   `json:"expectedDeploymentRevision"`
	ReviewToken                string                   `json:"reviewToken,omitempty"`
	OperationID                string                   `json:"operationId,omitempty"`
}
type exitEndpointView struct {
	EndpointID  string `json:"endpointId"`
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Protocol    string `json:"protocol"`
	Security    string `json:"security"`
	Transport   string `json:"transport"`
	TLSMaterial string `json:"tlsMaterial"`
}
type exitApplicationReadiness struct {
	State       string   `json:"state"`
	Code        string   `json:"code,omitempty"`
	EndpointIDs []string `json:"endpointIds,omitempty"`
}
type exitChangeReview struct {
	ApplicationReadiness exitApplicationReadiness `json:"applicationReadiness"`
	SecurityChanges      []string                 `json:"securityChanges"`
	RouteID              string                   `json:"routeId"`
	RouteName            string                   `json:"routeName"`
	ReviewToken          string                   `json:"reviewToken"`
	Before               exitEndpointView         `json:"before"`
	After                exitEndpointView         `json:"after"`
	AffectedUsers        int                      `json:"affectedUsers"`
	AddedProgram         bool                     `json:"addedProgram"`
	IsolatedConnector    bool                     `json:"isolatedConnector"`
	LegacyNormalized     bool                     `json:"legacyNormalized"`
	NativeChecked        bool                     `json:"nativeChecked"`
	PublicEntryPreserved bool                     `json:"publicEntryPreserved"`
	CredentialsPreserved bool                     `json:"credentialsPreserved"`
	OldProgramRetained   bool                     `json:"oldProgramRetained"`
}
type exitChangeResult struct {
	OperationID        string `json:"operationId"`
	RouteID            string `json:"routeId"`
	Status             string `json:"status"`
	RouteRevision      string `json:"routeRevision,omitempty"`
	DeploymentRevision string `json:"deploymentRevision,omitempty"`
	Code               string `json:"code,omitempty"`
	Detail             string `json:"detail,omitempty"`
}
type exitChangeReceipt struct {
	Actor        string           `json:"actor"`
	RouteID      string           `json:"routeId"`
	RequestToken string           `json:"requestToken"`
	Result       exitChangeResult `json:"result"`
}
type preparedExitChange struct {
	proof      preparedFleet
	deployment ServerDeployment
	changed    domain.ExitRetarget
	review     exitChangeReview
}
type exitChangeError struct {
	status int
	code   string
	detail string
}

func (e *exitChangeError) Error() string     { return e.detail }
func exitBlocked(code, detail string) error  { return &exitChangeError{422, code, detail} }
func exitConflict(code, detail string) error { return &exitChangeError{409, code, detail} }
func writeExitError(w http.ResponseWriter, err error) {
	var safe *exitChangeError
	if errors.As(err, &safe) {
		writeJSON(w, safe.status, map[string]string{"code": safe.code, "detail": safe.detail})
		return
	}
	if errors.Is(err, store.ErrConflict) {
		writeJSON(w, 409, map[string]string{"code": "EXIT_REVIEW_CHANGED", "detail": "线路或相关设置已变化，请重新检查。当前选择已保留。"})
		return
	}
	// Never return raw renderer, private-record, credential, or key errors.
	writeJSON(w, 422, map[string]string{"code": "EXIT_CHECK_UNAVAILABLE", "detail": "暂时无法核对出口变更，请刷新相关线路和服务器后重试。"})
}
func (h *server) strictExitRead(p *preparedFleet, kind, id string, out any) error {
	var raw json.RawMessage
	if e := h.fleetRead(p, kind, id, &raw, false); e != nil {
		return e
	}
	if e := strictSupported(raw, out); e != nil {
		return exitBlocked("EXIT_UNSUPPORTED_INTENT", "已保存设置包含此操作不支持的字段，原设置保持不变。")
	}
	return nil
}
func (h *server) registerRouteRetarget(r chi.Router) {
	handle := func(commit bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var in exitChangeInput
			if !decode(w, r, &in) {
				return
			}
			routeID := chi.URLParam(r, "id")
			actor := current(r).Account.ID
			if !domain.ValidID(routeID) || !domain.ValidID(in.ReplacementEndpointID) || (commit && !domain.ValidID(in.OperationID)) {
				fail(w, 400, "invalid route, endpoint or operation identity")
				return
			}
			// Handler is registered under requireAdmin. Receipt binding is checked before
			// looking at mutable baselines, allowing a lost success response to recover.
			requestInput := in
			requestInput.OperationID = ""
			requestToken, e := h.s.ReviewToken("exit-request/v1/"+actor+"/"+routeID, requestInput)
			if e != nil {
				writeExitError(w, e)
				return
			}
			receiptID := actor + ":" + in.OperationID
			if commit {
				var receipt exitChangeReceipt
				e = h.s.Get("route-exit-receipts", receiptID, &receipt)
				if e == nil {
					if receipt.Actor != actor || receipt.RouteID != routeID || !sameReviewToken(receipt.RequestToken, requestToken) {
						writeExitError(w, exitConflict("EXIT_OPERATION_REUSED", "此保存标识已用于其他变更，请重新检查。"))
						return
					}
					writeJSON(w, 200, receipt.Result)
					return
				}
				if e != store.ErrNotFound {
					writeExitError(w, e)
					return
				}
			}
			replayReceipt := func() bool {
				var prior exitChangeReceipt
				if commit && h.s.Get("route-exit-receipts", receiptID, &prior) == nil && prior.Actor == actor && prior.RouteID == routeID && sameReviewToken(prior.RequestToken, requestToken) {
					writeJSON(w, 200, prior.Result)
					return true
				}
				return false
			}
			// A durable negative outcome arbitrates against every original commit
			// using the same absence fence. Unknown/transient errors never claim it.
			rejectReceipt := func(cause error) bool {
				if !commit {
					return false
				}
				detail := ""
				var safe *exitChangeError
				switch {
				case errors.As(cause, &safe) && (safe.status == 409 || safe.status == 422):
					detail = safe.detail
				case errors.Is(cause, store.ErrConflict):
					detail = "线路或相关设置已变化，本次未保存。请重新检查当前选择。"
				case errors.Is(cause, store.ErrNotFound):
					detail = "线路或相关设置已不存在，本次未保存。请刷新后重新选择。"
				default:
					return false
				}
				result := exitChangeResult{OperationID: in.OperationID, RouteID: routeID, Status: "draft-rejected", Code: "EXIT_DRAFT_REJECTED", Detail: detail}
				receipt := exitChangeReceipt{Actor: actor, RouteID: routeID, RequestToken: requestToken, Result: result}
				err := h.s.CompareAndPutRecords([]store.RecordCompare{{Kind: "route-exit-receipts", ID: receiptID}}, []store.RecordWrite{{Kind: "route-exit-receipts", ID: receiptID, Value: receipt}})
				if err != nil {
					return replayReceipt()
				}
				writeJSON(w, 200, result)
				return true
			}
			prepared, e := h.prepareExitChange(actor, routeID, in)
			if e != nil {
				if replayReceipt() || rejectReceipt(e) {
					return
				}
				writeExitError(w, e)
				return
			}
			if !commit {
				writeJSON(w, 200, prepared.review)
				return
			}
			if !sameReviewToken(in.ReviewToken, prepared.review.ReviewToken) {
				if replayReceipt() || rejectReceipt(store.ErrConflict) {
					return
				}
				writeExitError(w, store.ErrConflict)
				return
			}
			prepared.deployment.IR = prepared.changed.IR
			prepared.deployment.Status = "draft"
			prepared.deployment.Diagnostics = []string{}
			prepared.deployment.UpdatedAt = time.Now().UTC()
			result := exitChangeResult{OperationID: in.OperationID, RouteID: routeID, Status: "draft-saved", RouteRevision: h.recordRevision("published-routes", routeID, prepared.changed.Route), DeploymentRevision: h.recordRevision("server-deployments", prepared.deployment.ID, prepared.deployment)}
			receipt := exitChangeReceipt{Actor: actor, RouteID: routeID, RequestToken: requestToken, Result: result}
			prepared.proof.Compares = append(prepared.proof.Compares, store.RecordCompare{Kind: "route-exit-receipts", ID: receiptID})
			writes := []store.RecordWrite{{Kind: "server-deployments", ID: prepared.deployment.ID, Value: prepared.deployment}, {Kind: "published-routes", ID: routeID, Value: prepared.changed.Route}, {Kind: "links", ID: prepared.changed.Link.ID, Value: prepared.changed.Link}, {Kind: "route-exit-receipts", ID: receiptID, Value: receipt}}
			if e = h.s.CompareSetsAndPutRecords(prepared.proof.Compares, prepared.proof.Sets, writes); e != nil {
				// Concurrent exact retries may race to the same transaction. Resolve only an
				// exact committed receipt; never turn another actor/request into a success.
				if replayReceipt() || rejectReceipt(e) {
					return
				}
				writeExitError(w, e)
				return
			}
			h.s.Audit(actor, "published-route.exit-draft-saved", routeID)
			writeJSON(w, 200, result)
		}
	}
	r.Post("/published-routes/{id}/retarget/preview", handle(false))
	r.Post("/published-routes/{id}/retarget", handle(true))
}

func (h *server) prepareExitChange(actor, routeID string, in exitChangeInput) (preparedExitChange, error) {
	out := preparedExitChange{}
	proof := &out.proof
	var route domain.PublishedRoute
	if e := h.strictExitRead(proof, "published-routes", routeID, &route); e != nil {
		return out, e
	}
	if e := h.strictExitRead(proof, "server-deployments", route.DeploymentID, &out.deployment); e != nil {
		return out, e
	}
	if !sameReviewToken(in.ExpectedRouteRevision, h.recordRevision("published-routes", routeID, proof.Compares[0].Expected)) || !sameReviewToken(in.ExpectedDeploymentRevision, h.recordRevision("server-deployments", out.deployment.ID, proof.Compares[1].Expected)) {
		return out, store.ErrConflict
	}
	if _, err := domain.ResolvePublishedRouteHops(route); err != nil || domain.HasExternalHops(route) {
		return out, exitBlocked("EXIT_PATH_UNSUPPORTED", "此操作不能省略外部代理。请保留完整链路后再修改。")
	}
	if len(route.EndpointIDs) != 2 || route.Path.Entry != route.EndpointIDs[0] || route.Path.Exit != route.EndpointIDs[1] {
		return out, exitBlocked("EXIT_PATH_UNSUPPORTED", "此操作支持保留入口、更换两段线路的直连出口。当前路径没有被改写。")
	}
	// Every retained snapshot remains exact. A separate listener refresh is never
	// smuggled into an exit change, including changes on unrelated programs.
	for _, program := range out.deployment.IR.Programs {
		var instance domain.CoreInstance
		var endpoint domain.ManagedEndpoint
		if e := h.strictExitRead(proof, "core-instances", program.Instance.ID, &instance); e != nil {
			return out, e
		}
		if e := h.strictExitRead(proof, "managed-endpoints", program.Listener.ID, &endpoint); e != nil {
			return out, e
		}
		if !reflect.DeepEqual(instance, program.Instance) || !reflect.DeepEqual(endpoint, program.Listener) {
			return out, exitConflict("EXIT_LISTENER_CHANGED", "路径中的监听或核心设置已变化，请先核对监听更新。")
		}
	}
	oldEndpoints := []domain.ManagedEndpoint{}
	for _, id := range route.EndpointIDs {
		var e domain.ManagedEndpoint
		if err := h.strictExitRead(proof, "managed-endpoints", id, &e); err != nil {
			return out, err
		}
		oldEndpoints = append(oldEndpoints, e)
	}
	action, e := h.publishedPathActionWithProof(out.deployment.IR, route, oldEndpoints, proof)
	if e != nil {
		var refusal *publishedPathRefusal
		if !errors.As(e, &refusal) {
			return out, e
		}
		return out, exitBlocked("EXIT_PATH_AMBIGUOUS", "此操作仅适用于固定两段转发路径，请先核对当前转发设置。")
	}
	principalCount := 0
	for _, p := range out.deployment.IR.Programs {
		if p.Listener.ID == route.Path.Entry {
			for _, principal := range p.Principals {
				if principal.RouteID == routeID {
					principalCount++
					if principal.Action != action {
						return out, exitBlocked("EXIT_PRINCIPAL_MISMATCH", "线路的用户入口与已保存路径不一致，请先核对用户入口。")
					}
				}
			}
		}
	}
	if principalCount == 0 {
		return out, exitBlocked("EXIT_NO_PRINCIPALS", "此线路尚未配置托管用户入口，请先完成用户入口配置。")
	}
	var endpoint domain.ManagedEndpoint
	var instance domain.CoreInstance
	var host domain.Host
	if e = h.strictExitRead(proof, "managed-endpoints", in.ReplacementEndpointID, &endpoint); e != nil {
		return out, e
	}
	if e = h.strictExitRead(proof, "core-instances", endpoint.InstanceID, &instance); e != nil {
		return out, e
	}
	if e = h.strictExitRead(proof, "hosts", instance.HostID, &host); e != nil {
		return out, e
	}
	if endpoint.Authentication == "principals" || instance.AdapterID == render.ServerAdapterManagedXray {
		return out, exitBlocked("EXIT_TRANSIT_PRINCIPAL_REQUIRED", "所选端点需要独立的中转用户绑定，不能直接作为出口。请选择已有连接凭据的端点。")
	}
	if endpoint.Connection.Protocol != "vless" || (endpoint.Connection.Transport != nil && endpoint.Connection.Transport.Type != "tcp") {
		return out, exitBlocked("EXIT_TARGET_UNSUPPORTED", "此出口变更目前支持具备连接凭据的 VLESS TCP 端点。请选择兼容端点。")
	}
	target := domain.ServerProgram{Instance: instance, Listener: endpoint, Egress: []domain.Connection{}, Rules: []domain.PolicyRule{}, Resources: []domain.RuleResource{}, DefaultAction: domain.ActionRef{Kind: "direct"}, TLS: in.TLS}
	existing := false
	for _, p := range out.deployment.IR.Programs {
		if p.Listener.ID == endpoint.ID {
			target = p
			existing = true
		}
	}
	if existing && in.TLS != nil {
		return out, exitBlocked("EXIT_TARGET_ALREADY_PREPARED", "所选出口已包含服务端设置；此操作不替换它的安全参数。")
	}
	if target.Listener.Connection.TLS != nil && target.Listener.Connection.TLS.Enabled && target.TLS == nil {
		return out, exitBlocked("EXIT_TLS_REQUIRED", "所选出口需要服务端证书与密钥设置，请补充该端点的现有 TLS 材料后重新检查。")
	}
	dial := endpoint.Connection
	if dial.Host == "0.0.0.0" || dial.Host == "::" {
		dial.Host = host.Address
	}
	if e = domain.ValidateConnection(dial); e != nil {
		return out, exitBlocked("EXIT_CONNECTION_INVALID", "所选端点的连接参数不完整，请先在服务器中修正该端点。")
	}
	tokenInput := in
	tokenInput.ReviewToken = ""
	tokenInput.OperationID = ""
	changeToken, e := h.s.ReviewToken("exit-intent/v1/"+actor+"/"+routeID, tokenInput)
	if e != nil {
		return out, e
	}
	changed, e := domain.RetargetManagedExit(out.deployment.IR, route, target, dial, "exit_"+changeToken[4:28], "topology_"+changeToken[4:28])
	if e != nil {
		return out, exitBlocked("EXIT_INTENT_UNSUPPORTED", "此变更无法保留当前路径的独立转发设置。请选择未占用核心上的直连出口，或先核对转发设置。")
	}
	if _, e = render.DefaultServers().Render(changed.IR); e != nil {
		return out, exitBlocked("EXIT_CONFIG_INVALID", "所选出口与当前核心或 TLS 设置不兼容，请核对所选端点的协议和服务端安全参数。")
	}
	all, e := h.fleetList(proof, "published-routes")
	if e != nil {
		return out, e
	}
	for _, raw := range all {
		// Classify safely before imposing this operation's preservation schema.
		// Unrelated future fields remain untouched; full membership/raw CAS and
		// candidate-instance ownership proofs are still retained.
		var identity struct {
			ID           string `json:"id"`
			DeploymentID string `json:"deploymentId"`
		}
		if json.Unmarshal(raw, &identity) != nil || !domain.ValidID(identity.ID) || !domain.ValidID(identity.DeploymentID) {
			return out, exitBlocked("EXIT_UNSUPPORTED_INTENT", "线路归属无法确认，原设置保持不变。")
		}
		if identity.DeploymentID != route.DeploymentID {
			continue
		}
		var other domain.PublishedRoute
		if strictSupported(raw, &other) != nil {
			return out, exitBlocked("EXIT_UNSUPPORTED_INTENT", "相关线路包含不支持的字段，原设置保持不变。")
		}
		if other.ID == routeID {
			other = changed.Route
		}
		endpoints := []domain.ManagedEndpoint{}
		for _, id := range other.EndpointIDs {
			found := false
			for _, p := range changed.IR.Programs {
				if p.Listener.ID == id {
					endpoints = append(endpoints, p.Listener)
					found = true
					break
				}
			}
			if !found {
				return out, exitBlocked("EXIT_RELATED_ROUTE_INVALID", "同一路径中的其他线路缺少监听端点，请先核对。")
			}
		}
		expected, err := h.publishedPathActionWithProof(changed.IR, other, endpoints, proof)
		if err != nil {
			var refusal *publishedPathRefusal
			if !errors.As(err, &refusal) {
				return out, err
			}
			return out, exitBlocked("EXIT_RELATED_ROUTE_INVALID", "变更不能保留同一路径中其他线路的转发，请核对相关线路。")
		}
		for _, p := range changed.IR.Programs {
			if p.Listener.ID == other.Path.Entry {
				for _, principal := range p.Principals {
					if principal.RouteID == other.ID && principal.Action != expected {
						return out, exitBlocked("EXIT_RELATED_PRINCIPAL_INVALID", "变更不能保留相关线路的用户入口，请先核对。")
					}
				}
			}
		}
	}
	for _, p := range changed.IR.Programs {
		if _, e = h.prepareInstanceOwnership(proof, p.Instance.ID, route.DeploymentID, "configure"); e != nil {
			var conflict *ownershipConflict
			if !errors.As(e, &conflict) {
				return out, e
			}
			return out, exitConflict("EXIT_INSTANCE_OWNERSHIP", "所选核心已有其他路径或无法确认的运行配置，请选择其他核心或先核对归属。")
		}
	}
	if e = h.exitActivationFence(proof, changed.IR); e != nil {
		return out, e
	}
	var existingLink domain.Link
	var existingLinkRaw json.RawMessage
	if e = h.fleetRead(proof, "links", changed.Link.ID, &existingLinkRaw, true); e != nil {
		return out, e
	}
	if existingLinkRaw != nil && strictSupported(existingLinkRaw, &existingLink) != nil {
		return out, exitBlocked("EXIT_UNSUPPORTED_INTENT", "相关连接包含不支持的字段，原设置保持不变。")
	}
	if existingLinkRaw != nil && existingLink != changed.Link {
		return out, store.ErrConflict
	}
	out.changed = changed
	view := func(e domain.ManagedEndpoint, address string, material *domain.ServerTLSOptions) exitEndpointView {
		security := "none"
		if e.Connection.TLS != nil && e.Connection.TLS.Enabled {
			security = "tls"
		}
		transport := "tcp"
		if e.Connection.Transport != nil && e.Connection.Transport.Type != "" {
			transport = e.Connection.Transport.Type
		}
		materialState := "none"
		if security == "tls" {
			materialState = "paths-only"
			if material != nil && material.CertificatePEM != "" && material.PrivateKeyPEM != "" {
				materialState = "provided"
			}
		}
		return exitEndpointView{TLSMaterial: materialState, EndpointID: e.ID, Name: e.Name, Host: address, Port: e.Connection.Port, Protocol: e.Connection.Protocol, Security: security, Transport: transport}
	}
	beforeAddress := oldEndpoints[1].Connection.Host
	if beforeAddress == "0.0.0.0" || beforeAddress == "::" {
		var core domain.CoreInstance
		var oldHost domain.Host
		if e = h.fleetRead(proof, "core-instances", oldEndpoints[1].InstanceID, &core, false); e != nil {
			return out, e
		}
		if e = h.fleetRead(proof, "hosts", core.HostID, &oldHost, false); e != nil {
			return out, e
		}
		beforeAddress = oldHost.Address
	}
	reviewInput := struct {
		Actor     string
		RouteID   string
		Input     exitChangeInput
		Compares  []store.RecordCompare
		Sets      []store.RecordSetCompare
		Candidate domain.ExitRetarget
	}{actor, routeID, tokenInput, semanticExitReviewCompares(proof.Compares), proof.Sets, changed}
	reviewToken, e := h.s.ReviewToken("exit-review/v1", reviewInput)
	if e != nil {
		return out, e
	}
	var beforeTLS *domain.ServerTLSOptions
	for _, program := range out.deployment.IR.Programs {
		if program.Listener.ID == oldEndpoints[1].ID {
			beforeTLS = program.TLS
		}
	}
	readiness := exitApplicationReadiness{State: "requires-apply-check"}
	for _, program := range changed.IR.Programs {
		if program.Listener.Connection.TLS != nil && program.Listener.Connection.TLS.Enabled && program.Listener.Connection.TLS.Reality == nil && (program.TLS == nil || program.TLS.CertificatePEM == "" || program.TLS.PrivateKeyPEM == "") {
			readiness.State = "blocked"
			readiness.Code = "tls-material-required"
			readiness.EndpointIDs = append(readiness.EndpointIDs, program.Listener.ID)
		}
	}
	out.review = exitChangeReview{SecurityChanges: exitSecurityChanges(oldEndpoints[1].Connection, endpoint.Connection), ApplicationReadiness: readiness, RouteID: routeID, RouteName: route.Name, ReviewToken: reviewToken, Before: view(oldEndpoints[1], beforeAddress, beforeTLS), After: view(endpoint, dial.Host, target.TLS), AffectedUsers: changed.AffectedUsers, AddedProgram: changed.AddedProgram, IsolatedConnector: true, LegacyNormalized: changed.LegacyNormalized, PublicEntryPreserved: true, CredentialsPreserved: true, OldProgramRetained: true}
	return out, nil
}

// Capture every activation baseline and pending Fleet membership. Direct apply
// and Fleet execute also compare the deployment, so either side of a race loses
// its old proof rather than scheduling an unseen intermediate intent.
func (h *server) exitActivationFence(proof *preparedFleet, ir domain.ServerDeploymentIR) error {
	instances := map[string]bool{}
	for _, p := range ir.Programs {
		instances[p.Instance.ID] = true
		var desired controlprotocol.Desired
		var state controlprotocol.State
		if e := h.fleetRead(proof, "agent-desired", p.Instance.ID, &desired, true); e != nil {
			return e
		}
		if e := h.fleetRead(proof, "agent-observations", p.Instance.ID, &state, true); e != nil {
			return e
		}
		if state.RecoveryRequired {
			return exitConflict("EXIT_RECOVERY_REQUIRED", "相关核心仍需恢复确认，请先在执行记录中处理。")
		}
		if desired.Generation > 0 {
			terminal := state.Phase == controlprotocol.ValidationFailed || state.Phase == controlprotocol.ApplyFailed || state.Phase == controlprotocol.Blocked
			complete := state.NativeChecked && state.Phase == controlprotocol.ObservedConformant && state.Observed != nil && state.Observed.Known && state.Observed.Quiescent && state.Observed.Identity == desired.Identity()
			if !complete && !(terminal && state.Desired != nil && *state.Desired == desired.Identity()) {
				return exitConflict("EXIT_APPLY_ACTIVE", "此路径仍有待执行或结果待确认的应用，请先在执行记录中处理，再更换出口。")
			}
		}
	}
	records, e := h.s.List("fleet-batches")
	if e != nil {
		return e
	}
	ids := []string{}
	for _, raw := range records {
		var record fleetRecord
		if json.Unmarshal(raw, &record) != nil || !domain.ValidID(record.Batch.ID) {
			return fmt.Errorf("cannot check execution records")
		}
		ids = append(ids, record.Batch.ID)
		proof.Compares = append(proof.Compares, store.RecordCompare{Kind: "fleet-batches", ID: record.Batch.ID, Expected: raw})
		touched, started, pending := false, len(record.Requests) > 0, false
		for _, target := range record.Batch.Targets {
			if instances[target.InstanceID] {
				touched = true
			}
			if len(target.Attempts) == 0 {
				pending = true
				continue
			}
			started = true
			attempt := target.Attempts[len(target.Attempts)-1]
			var state controlprotocol.State
			var observation *controlprotocol.State
			if attempt.Identity != nil {
				if e = h.fleetRead(proof, "agent-operation-observations", attempt.Identity.OperationID, &state, true); e != nil {
					return e
				}
				if state.Desired != nil || state.Observed != nil {
					observation = &state
				}
			}
			result := fleet.Outcome(record.Batch.Action, attempt, observation, time.Now())
			if result.Status != "succeeded" && result.Status != "failed" && result.Status != "superseded" {
				pending = true
			}
		}
		if touched && started && pending {
			return exitConflict("EXIT_FLEET_ACTIVE", "相关核心仍有未完成的批次，请先在执行记录中处理，再更换出口。")
		}
	}
	proof.Sets = append(proof.Sets, store.RecordSetCompare{Kind: "fleet-batches", IDs: ids})
	return nil
}

// The review binds semantic activation evidence, not a harmless observation
// timestamp. Commit still captures and CAS-checks the complete current records.
func semanticExitReviewCompares(compares []store.RecordCompare) []store.RecordCompare {
	out := append([]store.RecordCompare(nil), compares...)
	for i, compare := range out {
		if compare.Expected == nil || (compare.Kind != "agent-observations" && compare.Kind != "agent-operation-observations") {
			continue
		}
		raw, err := json.Marshal(compare.Expected)
		if err != nil {
			continue
		}
		var state controlprotocol.State
		if json.Unmarshal(raw, &state) != nil {
			continue
		}
		if state.Observed != nil {
			state.Observed.ObservedAt = time.Time{}
			state.Observed.Evidence = ""
		}
		out[i].Expected = state
	}
	return out
}

// Describe adopted security differences without returning private parameters.
func exitSecurityChanges(before, after domain.Connection) []string {
	changes := []string{}
	oldTLS, newTLS := before.TLS != nil && before.TLS.Enabled, after.TLS != nil && after.TLS.Enabled
	if oldTLS && !newTLS {
		changes = append(changes, "tls-disabled")
	}
	if !oldTLS && newTLS {
		changes = append(changes, "tls-enabled")
	}
	oldName, newName := "", ""
	if before.TLS != nil {
		oldName = before.TLS.ServerName
	}
	if after.TLS != nil {
		newName = after.TLS.ServerName
	}
	if oldName != newName {
		changes = append(changes, "server-name-changed")
	}
	if before.TLS != nil && after.TLS != nil && (before.TLS.Fingerprint != after.TLS.Fingerprint || !reflect.DeepEqual(before.TLS.ALPN, after.TLS.ALPN) || !reflect.DeepEqual(before.TLS.Reality, after.TLS.Reality)) {
		changes = append(changes, "tls-options-changed")
	}
	if !reflect.DeepEqual(before.Transport, after.Transport) {
		changes = append(changes, "transport-settings-changed")
	}
	if before.Flow != after.Flow {
		changes = append(changes, "flow-changed")
	}
	if before.PacketEncoding != after.PacketEncoding {
		changes = append(changes, "packet-encoding-changed")
	}
	return changes
}

