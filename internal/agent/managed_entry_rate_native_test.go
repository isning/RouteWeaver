//go:build linux

package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/entrypolicy"
)

// Deliberately a fake authority at the external admission boundary: this test
// proves executable enforcement, not CP policy conversion or entitlement logic.
type entryRateAuthority struct{}

func (entryRateAuthority) Acquire(_ context.Context, q entrypolicy.AdmissionRequest) (entrypolicy.Lease, error) {
	if q.EntryID != "entry-a" && q.EntryID != "entry-b" {
		return entrypolicy.Lease{}, fmt.Errorf("unexpected entry")
	}
	return entrypolicy.Lease{Allowed: true, LeaseID: q.PresenceID, AccountID: "account", RouteID: "route", ExpiresAt: time.Now().Add(30 * time.Second), EntryRateBPS: 65536}, nil
}
func (entryRateAuthority) Release(context.Context, string) error { return nil }

// One owned external pinned managed runtime, one account, two logical entries.
// Each entry has two simultaneous 128 KiB echoes: 512 KiB upload+download per
// entry, 1 MiB total. At 64 KiB/s and a 4 KiB burst each entry needs ~7.94 s.
// Separate direction/connection buckets finish ~4 s; an account-only shared
// bucket needs ~16 s. These finite loopback bounds are not a production SLA.
func TestManagedNativeEntryRateSharesDuplexAcrossConnectionsAndIsolatesEntries(t *testing.T) {
	source := os.Getenv("ROUTEWEAVER_MANAGED_XRAY_BIN")
	if source == "" {
		t.Skip("explicit managed native executable required")
	}
	root, err := os.MkdirTemp("", "rw-entry-rate-")
	if err != nil {
		t.Fatal(err)
	}
	// Always retain this bounded process/journal evidence for inspection.
	t.Logf("entry rate retained evidence=%s", root)
	content, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "immutable-managed-core")
	if err = os.WriteFile(binary, content, 0700); err != nil {
		t.Fatal(err)
	}
	t.Logf("managed executable sha256=%x adapter=%s version=%s", sha256.Sum256(content), ManagedXrayID, ManagedXrayVersion)
	checker, err := NewManagedXrayChecker(binary, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	supervisor, err := NewProcessSupervisor(checker, SupervisorOptions{AllowLocalProcess: true, StartupGrace: 150 * time.Millisecond, StopTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	desired := nativeDesired(t, ManagedXrayID, ManagedXrayVersion)
	reconciler, err := Open(root, desired.Scope, NewRegistry(supervisor), Options{MaxLease: 2 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	broker, err := StartAdmissionBroker(root, entryRateAuthority{})
	if err != nil {
		reconciler.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := supervisor.Stop(ctx, root); err != nil {
			t.Errorf("owned stop: %v", err)
		}
		observation, err := supervisor.Observe(ctx, root)
		absent := err == nil && observation.Known && observation.Quiescent && observation.Generation == 0
		if !absent {
			t.Errorf("owned absence unknown: %+v %v", observation, err)
		}
		if err := broker.Close(); err != nil {
			t.Errorf("broker close: %v", err)
		}
		if err := reconciler.Close(); err != nil {
			t.Errorf("reconciler close: %v", err)
		}
		t.Logf("entry rate cleanup owned_absent=%t checked_closes=true retained=%s", absent, root)
	})
	ports := []int{freeLoopbackPort(t), freeLoopbackPort(t)}
	inbounds := make([]string, 2)
	policy := entrypolicy.Descriptor{SchemaVersion: 1, AdapterID: ManagedXrayID, RuntimeVersion: ManagedXrayVersion, CoreVersion: "26.3.27", DestinationPolicy: entrypolicy.DestinationPolicy{AllowCIDRs: []string{"127.0.0.1/32"}}}
	for i, entry := range []string{"entry-a", "entry-b"} {
		inbounds[i] = fmt.Sprintf(`{"tag":%q,"listen":"127.0.0.1","port":%d,"protocol":"vless","settings":{"decryption":"none","clients":[{"id":"00112233-4455-6677-8899-aabbccddeeff","email":"subject"}]},"streamSettings":{"network":"tcp","security":"none"}}`, entry, ports[i])
		policy.Bindings = append(policy.Bindings, entrypolicy.Binding{SubjectID: "subject", AccountID: "account", RouteID: "route", EntryID: entry, InboundTag: entry, CredentialVersion: "credential", PolicyRevision: "policy", CycleID: "cycle"})
	}
	policyBytes, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	native := fmt.Sprintf(`{"log":{"loglevel":"none"},"inbounds":[%s,%s],"outbounds":[{"tag":"direct","protocol":"freedom"}]}`, inbounds[0], inbounds[1])
	desired.Artifacts = []domain.Artifact{{Path: "config.json", Content: native}, {Path: "entry-policy.json", Content: string(policyBytes)}}
	desired.Digest, err = ArtifactDigest(desired.Artifacts)
	if err != nil {
		t.Fatal(err)
	}
	state, err := reconciler.Submit(context.Background(), desired)
	if err != nil || state.Phase != ObservedConformant {
		t.Fatalf("managed activation phase=%s err=%v", state.Phase, err)
	}
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var targets sync.Map
	var serving sync.WaitGroup
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			targets.Store(c, true)
			serving.Add(1)
			go func() {
				defer serving.Done()
				defer targets.Delete(c)
				defer c.Close()
				c.SetDeadline(time.Now().Add(25 * time.Second))
				io.Copy(c, c)
			}()
		}
	}()
	t.Cleanup(func() {
		echo.Close()
		<-acceptDone
		targets.Range(func(k, v any) bool { k.(net.Conn).Close(); return true })
		serving.Wait()
	})
	clients := make([]net.Conn, 4)
	target := echo.Addr().(*net.TCPAddr).Port
	uuid, _ := hex.DecodeString("00112233445566778899aabbccddeeff")
	for i := range clients {
		c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", ports[i/2]), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		clients[i] = c
		t.Cleanup(func() { c.Close() })
		c.SetDeadline(time.Now().Add(3 * time.Second))
		header := append([]byte{0}, uuid...)
		header = append(header, 0, 1, byte(target>>8), byte(target), 1, 127, 0, 0, 1, 'w')
		if _, err := c.Write(header); err != nil {
			t.Fatal(err)
		}
		got := make([]byte, 3)
		if _, err := io.ReadFull(c, got); err != nil || !bytes.Equal(got, []byte{0, 0, 'w'}) {
			t.Fatalf("warmup %q %v", got, err)
		}
	}
	snapshot := func() entrypolicy.Snapshot {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		s, err := ReadManagedSnapshot(ctx, root)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	baseline := snapshot()
	if baseline.ActiveFlows != 4 || len(baseline.Counters) != 2 {
		t.Fatalf("warmup snapshot %+v", baseline)
	}
	epochs := map[string]string{}
	for _, c := range baseline.Counters {
		if c.UploadBytes != 2 || c.DownloadBytes != 2 || c.CounterEpoch == "" {
			t.Fatalf("warmup counters %+v", c)
		}
		epochs[c.EntryID] = c.CounterEpoch
	}
	// Validate stable attribution, not just two coincidentally equal totals.
	exactCounters := func(s entrypolicy.Snapshot, direction uint64) bool {
		if s.CounterEpoch != baseline.CounterEpoch || len(s.Counters) != 2 {
			return false
		}
		seen := map[string]bool{}
		for _, c := range s.Counters {
			if (c.EntryID != "entry-a" && c.EntryID != "entry-b") || seen[c.EntryID] || c.InboundTag != c.EntryID || c.AccountID != "account" || c.RouteID != "route" || c.SubjectID != "subject" || c.CounterEpoch != epochs[c.EntryID] || c.MeasurementLayer != entrypolicy.MeasurementLayer || c.UploadBytes != direction || c.DownloadBytes != direction || c.CumulativeBytes != 2*direction {
				return false
			}
			seen[c.EntryID] = true
		}
		return true
	}
	if !exactCounters(baseline, 2) {
		t.Fatalf("warmup attribution %+v", baseline)
	}
	type result struct {
		entry   int
		elapsed time.Duration
		err     error
	}
	results := make(chan result, 4)
	start := make(chan struct{})
	payload := bytes.Repeat([]byte("r"), 128<<10)
	began := time.Now()
	for i, c := range clients {
		go func(i int, c net.Conn) {
			<-start
			c.SetDeadline(began.Add(20 * time.Second))
			_, err := io.Copy(c, bytes.NewReader(payload))
			if err == nil {
				got := make([]byte, len(payload))
				_, err = io.ReadFull(c, got)
				if err == nil && !bytes.Equal(got, payload) {
					err = fmt.Errorf("payload mismatch")
				}
			}
			results <- result{i / 2, time.Since(began), err}
		}(i, c)
	}
	began = time.Now()
	close(start)
	var elapsed [2]time.Duration
	for range clients {
		r := <-results
		if r.err != nil {
			t.Errorf("entry %d payload: %v", r.entry, r.err)
		}
		if r.elapsed > elapsed[r.entry] {
			elapsed[r.entry] = r.elapsed
		}
	}
	for i, d := range elapsed {
		if d < 7500*time.Millisecond || d > 11500*time.Millisecond {
			t.Errorf("entry %d shared duplex independent rate elapsed=%s want 7.5–11.5s", i, d)
		}
	}
	after := snapshot()
	if !exactCounters(after, 262146) {
		t.Errorf("exact warmup+payload attribution %+v", after)
	}
	t.Logf("fake admission 65536B/s; per-entry upload=262144 download=262144; total payload=1048576; elapsed entry-a=%s entry-b=%s", elapsed[0], elapsed[1])
	// End both directions, then establish durable final counters after owned stop.
	for _, c := range clients {
		c.Close()
	}
	echo.Close()
	<-acceptDone
	targets.Range(func(k, v any) bool { k.(net.Conn).Close(); return true })
	serving.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := supervisor.Stop(ctx, root); err != nil {
		t.Fatal(err)
	}
	journals, err := ReadManagedJournal(root)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, s := range journals {
		if s.ActiveFlows == 0 && exactCounters(s, 262146) {
			found = true
		}
	}
	if !found {
		t.Fatal("exact stopped final byte proof absent from retained journal")
	}
	if _, err := os.Stat(filepath.Join(ManagedJournalDirectory(root), "running.json")); !os.IsNotExist(err) {
		t.Fatalf("clean final left uncertainty marker: %v", err)
	}
	t.Log("exact stopped journal: 1048576 timed payload bytes + 8 warmup bytes; no CP policy conversion or external network/SLA claim")
}
