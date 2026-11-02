package httpapi_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"routeweaver/internal/agent"
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
	"routeweaver/internal/store"
)

func terminalDigestForTest(t *testing.T, proof *entrypolicy.TerminalEvidence) {
	t.Helper()
	proof.Digest = ""
	raw, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	proof.Digest = hex.EncodeToString(sum[:])
}
func terminalBatchDigestForTest(t *testing.T, batch *controlprotocol.MeterBatch) {
	t.Helper()
	batch.Digest = ""
	raw, err := json.Marshal(batch)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	batch.Digest = hex.EncodeToString(sum[:])
}

func TestMeterTerminalCustodyRequiresExactProofAndAdminRetrieval(t *testing.T) {
	s, srv := makeServer(t)
	user := inviteClient(t, s, srv, "terminal-owner")
	instance := domain.CoreInstance{ID: "terminal-core", HostID: "terminal-host", AdapterID: agent.ManagedXrayID, Version: agent.ManagedXrayVersion}
	if err := s.Put("core-instances", instance.ID, instance); err != nil {
		t.Fatal(err)
	}
	admin := operatorClient()
	code, out, raw := req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": instance.HostID, "instanceId": instance.ID, "expiresAt": time.Now().Add(time.Hour)})
	if code != 201 {
		t.Fatalf("enroll %d %s", code, raw)
	}
	var scope agent.Scope
	encoded, _ := json.Marshal(out["scope"])
	if err := json.Unmarshal(encoded, &scope); err != nil {
		t.Fatal(err)
	}
	tr, err := agent.NewHTTPTransport(agent.HTTPTransportOptions{BaseURL: srv.URL, Token: out["token"].(string), Scope: scope, RequestTimeout: time.Second, MaxAttempts: 1, Backoff: time.Millisecond, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tr.Close()
	binding := store.MeterBinding{ID: "meter", InstanceID: instance.ID, UserID: user.id, SubjectID: "subject", RouteID: "route", PolicyRevision: "policy", CycleID: "cycle", MeasurementLayer: entrypolicy.MeasurementLayer, LedgerMode: "admission-budget"}
	if err = s.SetMeterBinding(binding); err != nil {
		t.Fatal(err)
	}
	spool, err := agent.OpenMeterSpool(filepath.Join(t.TempDir(), "spool"), scope, "stream")
	if err != nil {
		t.Fatal(err)
	}
	defer spool.Close()
	now := time.Now().UTC().Add(-time.Minute)
	counter := entrypolicy.Counter{CounterEpoch: "runtime-source", Binding: entrypolicy.Binding{SubjectID: "subject", AccountID: user.id, RouteID: "route", EntryID: "entry", InboundTag: "public", CredentialVersion: "v1", PolicyRevision: "policy", CycleID: "cycle"}, MeasurementLayer: entrypolicy.MeasurementLayer}
	baseline := entrypolicy.Snapshot{LedgerMode: "admission-budget", ObservedAt: now, AdapterID: agent.ManagedXrayID, RuntimeVersion: agent.ManagedXrayVersion, CounterEpoch: "runtime", Counters: []entrypolicy.Counter{counter}}
	for i, value := range []uint64{0, 37} {
		snap := baseline
		snap.ObservedAt = now.Add(time.Duration(i) * time.Second)
		snap.Counters = append([]entrypolicy.Counter(nil), baseline.Counters...)
		snap.Counters[0].UploadBytes = value
		snap.Counters[0].CumulativeBytes = value
		if err = spool.EnqueueManagedSnapshot(snap); err != nil {
			t.Fatal(err)
		}
		for _, batch := range spool.Pending() {
			receipt, e := tr.SendMeterBatch(context.Background(), batch)
			if e != nil {
				t.Fatal(e)
			}
			if receipt.CustodyVersion != 0 || receipt.TerminalEvidenceDigest != "" {
				t.Fatal("live ACK asserted terminal custody")
			}
			if err = spool.Ack(receipt); err != nil {
				t.Fatal(err)
			}
		}
	}
	final := baseline
	final.ObservedAt = now.Add(2 * time.Second)
	final.Counters = append([]entrypolicy.Counter(nil), baseline.Counters...)
	final.Counters[0].UploadBytes = 37
	final.Counters[0].CumulativeBytes = 37
	proof := &entrypolicy.TerminalEvidence{Version: 1, NodeID: scope.NodeID, InstanceID: scope.InstanceID, EnrollmentEpoch: scope.EnrollmentEpoch, RuntimeEpoch: "runtime", Baseline: baseline, Final: final}
	terminalDigestForTest(t, proof)
	batch := controlprotocol.MeterBatch{Scope: scope, StreamEpoch: "stream", Sequence: 3, Samples: []controlprotocol.MeterSample{}, TerminalEvidence: proof}
	terminalBatchDigestForTest(t, &batch)
	for _, mutation := range []struct {
		name   string
		change func(*entrypolicy.TerminalEvidence)
	}{
		{"wrong node", func(p *entrypolicy.TerminalEvidence) { p.NodeID = "other-node" }},
		{"baseline after durable live", func(p *entrypolicy.TerminalEvidence) { p.Baseline.ObservedAt = p.Final.ObservedAt }},
		{"unmeasured final", func(p *entrypolicy.TerminalEvidence) {
			p.Final.Counters[0].UploadBytes = 38
			p.Final.Counters[0].CumulativeBytes = 38
		}},
		{"wrong account", func(p *entrypolicy.TerminalEvidence) {
			p.Final.Counters[0].AccountID = "other-account"
			p.Baseline.Counters[0].AccountID = "other-account"
		}},
		{"live runtime", func(p *entrypolicy.TerminalEvidence) { p.Final.ActiveFlows = 1 }},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			changed := batch
			changed.TerminalEvidence = proof.Clone()
			mutation.change(changed.TerminalEvidence)
			terminalDigestForTest(t, changed.TerminalEvidence)
			terminalBatchDigestForTest(t, &changed)
			if _, err := tr.SendMeterBatch(context.Background(), changed); err == nil {
				t.Fatal("invalid terminal custody accepted")
			}
		})
	}
	receipt, err := tr.SendMeterBatch(context.Background(), batch)
	if err != nil || receipt.CustodyVersion != 1 || receipt.TerminalEvidenceDigest != proof.Digest {
		t.Fatalf("custody ACK: %+v %v", receipt, err)
	}
	if replay, e := tr.SendMeterBatch(context.Background(), batch); e != nil || replay != receipt {
		t.Fatalf("terminal replay %+v %v", replay, e)
	}
	q := url.Values{"enrollmentEpoch": {scope.EnrollmentEpoch}, "streamEpoch": {"stream"}, "sequence": {"3"}}
	endpoint := srv.URL + "/api/agent/instances/" + instance.ID + "/meter-terminal-evidence?" + q.Encode()
	code, _, raw = req(t, admin, http.MethodGet, endpoint, "", nil)
	var stored store.TerminalMeterEvidence
	if code != 200 || json.Unmarshal([]byte(raw), &stored) != nil || stored.CustodyVersion != 1 || stored.TerminalEvidence == nil || stored.TerminalEvidence.Digest != proof.Digest || stored.TerminalEvidence.Final.ActiveFlows != 0 || stored.TerminalEvidence.Final.Counters[0].CumulativeBytes != 37 {
		t.Fatalf("admin final evidence %d %s", code, raw)
	}
	if code, _, _ = req(t, user.c, http.MethodGet, endpoint, user.csrf, nil); code != 403 {
		t.Fatalf("tenant read terminal proof: %d", code)
	}
	if code, _, _ = req(t, http.DefaultClient, http.MethodGet, endpoint, "", nil); code != 401 {
		t.Fatalf("anonymous read terminal proof: %d", code)
	}
	q.Set("enrollmentEpoch", "other-enrollment")
	if code, _, _ = req(t, admin, http.MethodGet, srv.URL+"/api/agent/instances/"+instance.ID+"/meter-terminal-evidence?"+q.Encode(), "", nil); code != 404 {
		t.Fatalf("cross scope proof: %d", code)
	}
	t.Run("bounded discovery after forgotten stream", func(t *testing.T) {
		for i := 0; i < 20; i++ {
			id := fmt.Sprintf("%s:%s:000-live:%d", scope.InstanceID, scope.EnrollmentEpoch, i+1)
			if err := s.Put("meter-inbox", id, map[string]any{"samples": []any{}}); err != nil {
				t.Fatal(err)
			}
		}
		discovery := srv.URL + "/api/agent/instances/" + instance.ID + "/meter-terminal-evidence/receipts?enrollmentEpoch=" + url.QueryEscape(scope.EnrollmentEpoch)
		code, _, raw := req(t, admin, http.MethodGet, discovery, "", nil)
		var page store.TerminalEvidencePage
		if code != 200 || json.Unmarshal([]byte(raw), &page) != nil || page.Examined > 16 || !page.HasMore || page.NextCursor == "" || len(page.Items) != 0 {
			t.Fatalf("bounded first page %d %s", code, raw)
		}
		if code, _, _ = req(t, user.c, http.MethodGet, discovery, user.csrf, nil); code != 403 {
			t.Fatalf("tenant discovery %d", code)
		}
		if code, _, _ = req(t, http.DefaultClient, http.MethodGet, discovery, "", nil); code != 401 {
			t.Fatalf("anonymous discovery %d", code)
		}
		firstCursor := page.NextCursor
		next := discovery + "&cursor=" + url.QueryEscape(firstCursor)
		code, _, raw = req(t, admin, http.MethodGet, next, "", nil)
		if code != 200 || json.Unmarshal([]byte(raw), &page) != nil || page.HasMore || page.Examined > 16 || len(page.Items) != 1 || page.Items[0].EvidenceDigest != proof.Digest {
			t.Fatalf("terminal discovery continuation %d %s", code, raw)
		}
		for _, bad := range []string{"malformed", firstCursor + "x"} {
			if code, _, _ = req(t, admin, http.MethodGet, discovery+"&cursor="+url.QueryEscape(bad), "", nil); code != 400 {
				t.Fatalf("malformed discovery cursor %d", code)
			}
		}
		if _, err := s.DiscoverMeterTerminalEvidence(context.Background(), instance.ID, "other-enrollment", firstCursor); err == nil {
			t.Fatal("cross-enrollment cursor accepted")
		}
		if _, err := s.DiscoverMeterTerminalEvidence(context.Background(), "other-instance", scope.EnrollmentEpoch, firstCursor); err == nil {
			t.Fatal("cross-instance cursor accepted")
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := s.DiscoverMeterTerminalEvidence(ctx, instance.ID, scope.EnrollmentEpoch, ""); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled discovery %v", err)
		}
	})
	// Logical backup/restore uses opaque canonical raw records: future terminal
	// fields must not be decoded through an older typed meter sample projection.
	restoredPath := filepath.Join(t.TempDir(), "restored.db")
	key := bytes.Repeat([]byte{11}, 32)
	limits := store.BackupLimits{MaxRows: 10000, MaxBytes: 8 << 20, MaxRecordBytes: 1 << 20}
	if err = store.RestoreBackupFresh(context.Background(), restoredPath, key, s, limits); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(restoredPath, key)
	if err != nil {
		t.Fatal(err)
	}
	restoredProof, err := restored.MeterTerminalEvidence(instance.ID, scope.EnrollmentEpoch, "stream", 3)
	restored.Close()
	if err != nil || restoredProof.TerminalEvidence == nil || restoredProof.TerminalEvidence.Digest != proof.Digest {
		t.Fatalf("terminal proof lost through backup: %+v %v", restoredProof, err)
	}
	// Rewriting a final and its inner digest must not bypass the outer batch digest.
	id := fmt.Sprintf("%s:%s:stream:3", scope.InstanceID, scope.EnrollmentEpoch)
	tampered := batch
	tampered.TerminalEvidence = proof.Clone()
	tampered.TerminalEvidence.Final.ObservedAt = tampered.TerminalEvidence.Final.ObservedAt.Add(time.Second)
	terminalDigestForTest(t, tampered.TerminalEvidence)
	if err = s.Put("meter-inbox", id, tampered); err != nil {
		t.Fatal(err)
	}
	if _, err = s.MeterTerminalEvidence(instance.ID, scope.EnrollmentEpoch, "stream", 3); err == nil {
		t.Fatal("tampered outer custody digest accepted")
	}
	if err = s.Put("meter-inbox", id, batch); err != nil {
		t.Fatal(err)
	}
	if err = s.Put("meter-inbox", id, strings.Repeat("x", (1<<20)+1)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.MeterTerminalEvidence(instance.ID, scope.EnrollmentEpoch, "stream", 3); err == nil {
		t.Fatal("oversized retained inbox read accepted")
	}
	if err = s.Put("meter-inbox", id, batch); err != nil {
		t.Fatal(err)
	}
	receiptID := id
	if err = s.Put("meter-receipts", receiptID, strings.Repeat("x", 129)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.MeterTerminalEvidence(instance.ID, scope.EnrollmentEpoch, "stream", 3); err == nil {
		t.Fatal("oversized custody receipt accepted")
	}
	if err = s.Put("meter-receipts", receiptID, batch.Digest); err != nil {
		t.Fatal(err)
	}
	// A matching old/live digest receipt without retained terminal content cannot
	// acquire custody semantics on replay, even if the sender repeats valid proof.
	withoutProof := batch
	withoutProof.TerminalEvidence = nil
	if err = s.Put("meter-inbox", id, withoutProof); err != nil {
		t.Fatal(err)
	}
	if _, err = tr.SendMeterBatch(context.Background(), batch); err == nil {
		t.Fatal("legacy receipt without retained proof acknowledged terminal custody")
	}
	if err = s.Put("meter-inbox", id, batch); err != nil {
		t.Fatal(err)
	}
	t.Run("historical evidence survives reenrollment and instance removal", func(t *testing.T) {
		changed := instance
		changed.Name = "New configuration"
		if err := s.Put("core-instances", instance.ID, changed); err != nil {
			t.Fatal(err)
		}
		laterBinding := binding
		laterBinding.ID = "later-binding"
		laterBinding.PolicyRevision = "later-policy"
		if err := s.SetMeterBinding(laterBinding); err != nil {
			t.Fatal(err)
		}
		if code, _, raw := req(t, admin, "POST", srv.URL+"/api/agent/enrollments", "", map[string]any{"nodeId": instance.HostID, "instanceId": instance.ID, "expiresAt": time.Now().Add(time.Hour)}); code != 201 {
			t.Fatalf("reenrollment %d %s", code, raw)
		}
		_, rejected := tr.SendMeterBatch(context.Background(), batch)
		var unauthorized *agent.TransportError
		if !errors.As(rejected, &unauthorized) || unauthorized.Status != http.StatusUnauthorized {
			t.Fatalf("revoked agent must fail authentication, got %v", rejected)
		}
		verify := func() {
			t.Helper()
			if code, _, raw := req(t, admin, http.MethodGet, endpoint, "", nil); code != 200 {
				t.Fatalf("historical exact retrieval %d %s", code, raw)
			}
			cursor := ""
			found := false
			for i := 0; i < 3; i++ {
				discovery := srv.URL + "/api/agent/instances/" + instance.ID + "/meter-terminal-evidence/receipts?enrollmentEpoch=" + url.QueryEscape(scope.EnrollmentEpoch) + "&cursor=" + url.QueryEscape(cursor)
				code, _, raw := req(t, admin, http.MethodGet, discovery, "", nil)
				var page store.TerminalEvidencePage
				if code != 200 || json.Unmarshal([]byte(raw), &page) != nil {
					t.Fatalf("historical discovery %d %s", code, raw)
				}
				for _, item := range page.Items {
					if item.EvidenceDigest == proof.Digest {
						found = true
					}
				}
				if !page.HasMore {
					break
				}
				cursor = page.NextCursor
			}
			if !found {
				t.Fatal("historical enrollment proof not discoverable")
			}
		}
		verify()
		if err := s.Remove("core-instances", instance.ID); err != nil {
			t.Fatal(err)
		}
		verify()
	})
}

func TestMeterTerminalDiscoveryBoundsMalformedRecordsAndBytes(t *testing.T) {
	s, _ := makeServer(t)
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("instance:enrollment:stream:%d", i+1)
		if err := s.Put("meter-inbox", id, map[string]any{"samples": []any{}, "padding": strings.Repeat("x", 900<<10)}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.DiscoverMeterTerminalEvidence(context.Background(), "instance", "enrollment", "")
	if err != nil || !page.HasMore || page.Examined != 3 || page.NextCursor == "" {
		t.Fatalf("byte bounded page %+v %v", page, err)
	}
	next, err := s.DiscoverMeterTerminalEvidence(context.Background(), "instance", "enrollment", page.NextCursor)
	if err != nil || next.HasMore || next.Examined != 1 {
		t.Fatalf("byte bounded continuation %+v %v", next, err)
	}
	if err = s.Put("meter-inbox", "instance:enrollment:stream:1", strings.Repeat("x", (1<<20)+1)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DiscoverMeterTerminalEvidence(context.Background(), "instance", "enrollment", ""); err == nil {
		t.Fatal("oversized discovery row accepted")
	}
	if err = s.Put("meter-inbox", "instance:enrollment:stream:1", "not an envelope"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.DiscoverMeterTerminalEvidence(context.Background(), "instance", "enrollment", ""); err == nil {
		t.Fatal("malformed discovery row silently omitted")
	}
}
