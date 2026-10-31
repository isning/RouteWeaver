package backup_test

import (
	"bytes"
	"context"
	"encoding/json"
	"filippo.io/age"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/store"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStreamingBackupRestoresBeyondLegacyCapacity(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{51}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	secret := "synthetic-private-ledger-detail-" + string(bytes.Repeat([]byte("x"), 64<<10))
	for i := 0; i < 300; i++ {
		if err = s.Put("ledger", stringID(i), map[string]any{"sequence": i, "detail": secret}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.ExportSnapshot(ctx); err == nil {
		t.Fatal("fixture must exceed legacy capacity")
	}
	file, err := os.CreateTemp(t.TempDir(), "backup-*.age")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err = backup.CreateStream(ctx, s, "synthetic-long-backup-passphrase", file, backup.DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	info, _ := file.Stat()
	if info.Size() <= 16<<20 {
		t.Fatal("fixture did not exceed old archive limit")
	}
	file.Seek(0, 0)
	p, err := backup.PreviewStream(ctx, file, "synthetic-long-backup-passphrase", backup.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if p.Summary().Manifest.Records != 301 || p.Summary().Manifest.Version != 2 {
		t.Fatalf("wrong manifest: %+v", p.Summary())
	}
	target := filepath.Join(t.TempDir(), "restored.db")
	key := bytes.Repeat([]byte{52}, 32)
	if err = p.Restore(ctx, target, key); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	for _, i := range []int{0, 149, 299} {
		var got struct {
			Sequence int
			Detail   string
		}
		if err = restored.Get("ledger", stringID(i), &got); err != nil || got.Sequence != i || got.Detail != secret {
			t.Fatalf("record %d lost: %v", i, err)
		}
	}
}
func stringID(i int) string { return fmt.Sprintf("entry-%06d", i) }

func TestStreamingBackupLedgerGrowthAndCompleteRecovery(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "ledger.db"), bytes.Repeat([]byte{61}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.EnsureAdmin("operator", "synthetic-login-password"); err != nil {
		t.Fatal(err)
	}
	var account store.Account
	if err = s.Get("accounts", "admin", &account); err != nil {
		t.Fatal(err)
	}
	account.PendingTOTPSecret = "JBSWY3DPEHPK3PXP"
	account.LastTOTPStep = 42
	if err = s.Put("accounts", "admin", account); err != nil {
		t.Fatal(err)
	}
	if err = s.PutWithToken("tenant/admin/outputs", "feed", map[string]string{"status": "published", "tokenDigest": "fixture-digest", "token": "synthetic-feed-secret"}, "feeds", "", "fixture-digest", "admin/feed"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err = s.GenerateRecord("agent-desired", "core1", func(g uint64) (any, error) { return map[string]uint64{"generation": g}, nil }); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.Put("published-manifests", "m1", map[string]any{"identity": map[string]any{"instanceId": "core1", "generation": "3"}}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.GenerateRecord("agent-desired", "removed", func(g uint64) (any, error) { return map[string]uint64{"generation": g}, nil }); err != nil {
		t.Fatal(err)
	}
	if err = s.Remove("agent-desired", "removed"); err != nil {
		t.Fatal(err)
	}
	rows := 40000
	if configured := os.Getenv("ROUTEWEAVER_BACKUP_BENCH_ROWS"); configured != "" {
		rows, err = strconv.Atoi(configured)
		if err != nil || rows < 40000 || rows > 1000000 {
			t.Fatal("invalid benchmark row count")
		}
	}
	at := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	record := store.MeterRecord{MeterBatch: store.MeterBatch{UserID: "synthetic-user", RouteID: "synthetic-route", MeterID: "synthetic-meter", Epoch: "synthetic-epoch", RawBytes: 1024, ObservedAt: at}, IntervalStart: at.Add(-time.Minute), IntervalEnd: at, WeightedBytes: 1024, RateID: "synthetic-rate", RateMicros: 1000000, RecordedAt: at}
	for i := 0; i < rows; i++ {
		record.Sequence = uint64(i + 1)
		if err = s.Put("ledger", stringID(i), record); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.ExportSnapshot(ctx); err == nil {
		t.Fatal("realistic ledger fixture must exceed original snapshot cap")
	}
	file, err := os.CreateTemp(t.TempDir(), "ledger-*.age")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	runtime.GC()
	var peak atomic.Uint64
	done := make(chan struct{})
	sampled := make(chan struct{})
	go func() {
		defer close(sampled)
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				var m runtime.MemStats
				runtime.ReadMemStats(&m)
				for old := peak.Load(); m.HeapAlloc > old; old = peak.Load() {
					if peak.CompareAndSwap(old, m.HeapAlloc) {
						break
					}
				}
			}
		}
	}()
	defer func() {
		close(done)
		<-sampled
		t.Logf("streaming ledger rows=%d peak sampled Go heap=%d bytes", rows, peak.Load())
	}()
	if err = backup.CreateStream(ctx, s, "synthetic-long-backup-passphrase", file, backup.DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	info, _ := file.Stat()
	t.Logf("ciphertext bytes=%d", info.Size())
	if info.Size() <= 16<<20 {
		t.Fatal("realistic archive did not exceed legacy16MiB")
	}
	file.Seek(0, 0)
	p, err := backup.PreviewStream(ctx, file, "synthetic-long-backup-passphrase", backup.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if p.Summary().Counts["ledger"] != rows {
		t.Fatal("ledger history truncated")
	}
	target := filepath.Join(t.TempDir(), "restored.db")
	key := bytes.Repeat([]byte{62}, 32)
	if err = p.Restore(ctx, target, key); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(target, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if _, err = restored.Authenticate("operator", "synthetic-login-password", "", time.Now()); err != nil {
		t.Fatal("password identity lost:", err)
	}
	if err = restored.Get("accounts", "admin", &account); err != nil || account.PendingTOTPSecret != "JBSWY3DPEHPK3PXP" || account.LastTOTPStep != 42 {
		t.Fatal("MFA lost")
	}
	var feed map[string]string
	if err = restored.Get("tenant/admin/outputs", "feed", &feed); err != nil || feed["token"] != "synthetic-feed-secret" {
		t.Fatal("feed secret lost")
	}
	if got, e := restored.LookupToken("feeds", "fixture-digest"); e != nil || got != "admin/feed" {
		t.Fatal("feed index lost")
	}
	for _, core := range []string{"core1", "removed"} {
		want := uint64(4)
		if core == "removed" {
			want = 2
		}
		got, e := restored.GenerateRecord("agent-desired", core, func(g uint64) (any, error) { return map[string]uint64{"generation": g}, nil })
		if e != nil || got != want {
			t.Fatalf("counter %s lost: %d %v", core, got, e)
		}
	}
	for _, i := range []int{0, rows / 2, rows - 1} {
		var got store.MeterRecord
		if err = restored.Get("ledger", stringID(i), &got); err != nil || got.Sequence != uint64(i+1) || got.RawBytes != 1024 || got.RateID != "synthetic-rate" {
			t.Fatalf("ledger %d lost: %+v %v", i, got, err)
		}
	}
}

func TestStreamingBackupRejectsUnauthenticatedOrMalformedFramesAndCleansStaging(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{63}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.PutWithToken("tenant/admin/outputs", "feed", map[string]string{"status": "published", "tokenDigest": "digest", "token": "synthetic-secret-never-on-disk"}, "feeds", "", "digest", "admin/feed"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.GenerateRecord("agent-desired", "core1", func(g uint64) (any, error) { return map[string]uint64{"generation": g}, nil }); err != nil {
		t.Fatal(err)
	}
	var encrypted bytes.Buffer
	if err = backup.CreateStream(ctx, s, "synthetic-long-backup-passphrase", &encrypted, backup.DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	identity, _ := age.NewScryptIdentity("synthetic-long-backup-passphrase")
	r, err := age.Decrypt(bytes.NewReader(encrypted.Bytes()), identity)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	temp := t.TempDir()
	t.Setenv("TMPDIR", temp)
	cases := map[string][]byte{
		"truncated ciphertext": encrypted.Bytes()[:encrypted.Len()-1],
		"trailing ciphertext":  append(append([]byte{}, encrypted.Bytes()...), 1),
	}
	cases["excessive KDF"] = bytes.Replace(encrypted.Bytes(), []byte(" 18\n"), []byte(" 30\n"), 1)
	tampered := append([]byte{}, encrypted.Bytes()...)
	tampered[len(tampered)-1] ^= 1
	cases["tampered ciphertext"] = tampered
	mutate := func(name string, fn func([]string) []string) {
		lines := strings.Split(strings.TrimSpace(string(plain)), "\n")
		cases[name] = encryptStreamFixture(t, []byte(strings.Join(fn(lines), "\n")+"\n"))
	}
	mutate("unknown schema", func(v []string) []string {
		v[0] = strings.Replace(v[0], `"schemaVersion":2`, `"schemaVersion":999`, 1)
		return v
	})
	mutate("unknown frame field", func(v []string) []string { v[1] = `{"sql":"DROP TABLE records"}`; return v })
	mutate("duplicate row", func(v []string) []string { return append(v[:2], append([]string{v[1]}, v[2:]...)...) })
	mutate("mixed frame", func(v []string) []string {
		v[1] = strings.TrimSuffix(v[1], "}") + `,"counter":{"kind":"agent-desired","id":"other","value":1}}`
		return v
	})
	mutate("unordered row", func(v []string) []string { v[1], v[2] = v[2], v[1]; return v })
	mutate("missing migration", func(v []string) []string {
		out := []string{}
		for _, line := range v {
			if strings.HasPrefix(line, `{"migration":{"version":2`) {
				continue
			}
			out = append(out, line)
		}
		return out
	})
	mutate("missing footer", func(v []string) []string { return v[:len(v)-1] })
	mutate("wrong footer count", func(v []string) []string {
		v[len(v)-1] = strings.Replace(v[len(v)-1], `"records":3`, `"records":9`, 1)
		return v
	})
	mutate("missing feed index", func(v []string) []string {
		out := []string{}
		for _, line := range v {
			if strings.HasPrefix(line, `{"token":`) {
				continue
			}
			out = append(out, strings.Replace(line, `"tokens":1`, `"tokens":0`, 1))
		}
		return out
	})
	mutate("behind generation", func(v []string) []string {
		for i, line := range v {
			if strings.HasPrefix(line, `{"counter":`) {
				v[i] = strings.Replace(line, `"value":1`, `"value":0`, 1)
			}
		}
		return v
	})
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if p, e := backup.PreviewStream(ctx, bytes.NewReader(data), "synthetic-long-backup-passphrase", backup.DefaultLimits()); e == nil {
				p.Close()
				t.Fatal("invalid stream accepted")
			}
			entries, _ := os.ReadDir(temp)
			if len(entries) != 0 {
				t.Fatal("failed preview leaked encrypted staging")
			}
		})
	}
	for name, l := range map[string]backup.Limits{"total": {ArchiveBytes: 256}, "rows": {Rows: 2}, "record": {RecordBytes: 16}} {
		t.Run(name, func(t *testing.T) {
			if p, e := backup.PreviewStream(ctx, bytes.NewReader(encrypted.Bytes()), "synthetic-long-backup-passphrase", l); e == nil {
				p.Close()
				t.Fatal("configured resource bound ignored")
			}
		})
	}
	p, err := backup.PreviewStream(ctx, bytes.NewReader(encrypted.Bytes()), "synthetic-long-backup-passphrase", backup.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(temp); len(entries) != 1 {
		t.Fatalf("expected one private encrypted stage, got%d", len(entries))
	}
	if err = filepath.Walk(temp, func(path string, info os.FileInfo, e error) error {
		if e != nil {
			return e
		}
		if path == temp {
			return nil
		}
		want := os.FileMode(0600)
		if info.IsDir() {
			want = 0700
		}
		if info.Mode().Perm() != want {
			return fmt.Errorf("unsafe stage permissions:%s %v", info.Name(), info.Mode())
		}
		if !info.IsDir() {
			raw, e := os.ReadFile(path)
			if e != nil {
				return e
			}
			if bytes.Contains(raw, []byte("synthetic-secret-never-on-disk")) {
				return fmt.Errorf("plaintext secret persisted")
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err = p.Close(); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(temp); len(entries) != 0 {
		t.Fatal("close leaked staging")
	}
	legacy, err := backup.Create(ctx, s, "synthetic-long-backup-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	old, err := backup.PreviewStream(ctx, bytes.NewReader(legacy), "synthetic-long-backup-passphrase", backup.DefaultLimits())
	if err != nil {
		t.Fatal("v1 import compatibility lost:", err)
	}
	defer old.Close()
	if old.Summary().Manifest.Version != 1 {
		t.Fatal("not legacy")
	}
	snapshot, err := s.ExportSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	pretty, err := json.MarshalIndent(map[string]any{"manifest": old.Summary().Manifest, "snapshot": snapshot}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	formatted, err := backup.PreviewStream(ctx, bytes.NewReader(encryptStreamFixture(t, pretty)), "synthetic-long-backup-passphrase", backup.DefaultLimits())
	if err != nil {
		t.Fatal("formatted v1 compatibility lost:", err)
	}
	formatted.Close()

}
func encryptStreamFixture(t *testing.T, plain []byte) []byte {
	t.Helper()
	recipient, _ := age.NewScryptRecipient("synthetic-long-backup-passphrase")
	recipient.SetWorkFactor(10)
	var out bytes.Buffer
	w, err := age.Encrypt(&out, recipient)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
