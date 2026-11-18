package httpapi

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/auth"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
)

func (h *server) registerHostCoreInstall(r chi.Router) {
	r.Post("/admin/hosts/{nodeId}/cores/{instanceId}/install", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ReleaseID          string `json:"releaseId"`
			ExpectedGeneration string `json:"expectedGeneration"`
		}
		if !decode(w, r, &in) {
			return
		}
		expected, err := strconv.ParseUint(in.ExpectedGeneration, 10, 64)
		if err != nil || strconv.FormatUint(expected, 10) != in.ExpectedGeneration {
			fail(w, 400, "请刷新核心状态后再安装")
			return
		}
		release, err := controlprotocol.FindInstallableCoreRelease(in.ReleaseID)
		if err != nil {
			fail(w, 400, "请选择远程安装目录中的核心版本")
			return
		}
		node, id := chi.URLParam(r, "nodeId"), chi.URLParam(r, "instanceId")
		proof := preparedFleet{}
		var host domain.Host
		var instance domain.CoreInstance
		var parent hostEnrollment
		var enrollment Enrollment
		var previous controlprotocol.Desired
		for _, item := range []struct {
			kind, id string
			out      any
			optional bool
		}{{"hosts", node, &host, false}, {"core-instances", id, &instance, false}, {"host-enrollments", node, &parent, false}, {"instance-enrollments", id, &enrollment, false}, {"agent-desired", id, &previous, true}} {
			if err = h.fleetRead(&proof, item.kind, item.id, item.out, item.optional); err != nil {
				storeError(w, err)
				return
			}
		}
		if instance.HostID != node || instance.AdapterID != release.AdapterID || instance.Version != release.Version {
			fail(w, 409, "安装版本与此服务器的核心记录不一致，请刷新后重试")
			return
		}
		if parent.Revoked || !time.Now().Before(parent.ExpiresAt) || enrollment.Revoked || enrollment.HostEnrollmentEpoch != parent.EnrollmentEpoch || enrollment.Scope.NodeID != node || enrollment.Scope.InstanceID != id || !time.Now().Before(enrollment.ExpiresAt) {
			fail(w, 409, "请先接入此服务器的 Agent")
			return
		}
		if previous.Generation != expected {
			fail(w, 409, "核心任务已变更，请刷新后重试")
			return
		}
		// Installation of a newly registered core is separate from replacing a running
		// configuration. Existing execution/upgrade uses the reviewed fleet workflow.
		if previous.Generation > 0 && previous.Action != "install" {
			fail(w, 409, "此核心已有运行配置，请通过核心维护流程安装或升级")
			return
		}
		revision, err := auth.Token()
		if err != nil {
			fail(w, 500, "无法准备安装任务，请重试")
			return
		}
		operation, err := auth.Token()
		if err != nil {
			fail(w, 500, "无法准备安装任务，请重试")
			return
		}
		content := `{"inbounds":[],"outbounds":[{"type":"direct","tag":"direct"}]}`
		if release.AdapterID == "routeweaver/xray" {
			content = `{"inbounds":[],"outbounds":[{"protocol":"freedom","tag":"direct"}]}`
		}
		artifacts := []domain.Artifact{{Path: "config.json", Content: content}}
		digest, err := controlprotocol.ArtifactDigest(artifacts)
		if err != nil {
			fail(w, 500, "无法生成安装任务，请重试")
			return
		}
		now := time.Now().UTC()
		expiry := now.Add(10 * time.Minute)
		if parent.ExpiresAt.Before(expiry) {
			expiry = parent.ExpiresAt
		}
		var desired controlprotocol.Desired
		_, err = h.s.CompareSetsAndGenerateRecord("agent-desired", id, proof.Compares, proof.Sets, func(g uint64) (any, []store.RecordWrite, error) {
			desired = controlprotocol.Desired{Scope: enrollment.Scope, Action: "install", CoreReleaseID: release.ID, AdapterID: release.AdapterID, CoreVersion: release.Version, Generation: g, RevisionID: "install_" + revision, OperationID: "install_" + operation, EntryFile: "config.json", Digest: digest, Artifacts: artifacts, Lease: controlprotocol.PolicyLease{Revision: "install_" + revision, IssuedAt: now, ExpiresAt: expiry, AccessAllowed: false, QuotaCertain: true}}
			if err := controlprotocol.ValidateDesired(desired, enrollment.Scope); err != nil {
				return nil, nil, fmt.Errorf("invalid installation envelope: %w", err)
			}
			return desired, nil, nil
		})
		if err != nil {
			storeError(w, err)
			return
		}
		h.s.Audit(current(r).Account.ID, "core.install.queued", node+"/"+id)
		writeJSON(w, 202, map[string]any{"phase": "queued", "desired": desired.Identity()})
	})
}
