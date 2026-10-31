package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

type backupDeadlineRecorder struct {
	http.ResponseWriter
	read, write time.Time
}

func (w *backupDeadlineRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *backupDeadlineRecorder) SetReadDeadline(d time.Time) error {
	w.read = d
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(d)
}
func (w *backupDeadlineRecorder) SetWriteDeadline(d time.Time) error {
	w.write = d
	return http.NewResponseController(w.ResponseWriter).SetWriteDeadline(d)
}

func TestBackupRestoreReservesOnlyItsResultWriteWindow(t *testing.T) {
	const token = "012345678901234567890123456789012345"
	for _, tc := range []struct {
		name, path, authorization string
		allowance                 time.Duration
		status                    int
	}{
		{"restore", "/api/admin/backups/restore", token, time.Second, 409},
		{"export error", "/api/admin/backups", token, time.Second, 400},
		{"preview", "/api/admin/backups/preview", token, 0, 400},
		{"unauthorized restore", "/api/admin/backups/restore", "invalid", 0, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			observed := make(chan *backupDeadlineRecorder, 1)
			h := NewWithOptions(nil, render.Default(), Options{AdminToken: token, BackupLimits: backup.Limits{Duration: 30 * time.Second}})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				wrapped := &backupDeadlineRecorder{ResponseWriter: w}
				h.ServeHTTP(wrapped, r)
				observed <- wrapped
			}))
			defer srv.Close()
			req, _ := http.NewRequest("POST", srv.URL+tc.path, bytes.NewBufferString(`{"password":"short"}`))
			req.Header.Set("Authorization", "Bearer "+tc.authorization)
			req.Header.Set("Content-Type", "application/json")
			response, err := srv.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.status {
				t.Fatalf("status %d", response.StatusCode)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			got := <-observed
			if tc.status == 401 {
				if !got.read.IsZero() || !got.write.IsZero() {
					t.Fatal("unauthorized request received backup deadline extension")
				}
			} else if got.read.IsZero() || got.write.Sub(got.read) != tc.allowance {
				t.Fatalf("write/read allowance = %s; want %s", got.write.Sub(got.read), tc.allowance)
			}
		})
	}
}

func TestBackupRestoreCompletedOutcomeAndReceipt(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		status   int
		outcome  string
		consumed bool
	}{
		{"durable", nil, 201, "", true},
		{"before publication", errors.New("private disk cause"), 500, "not_published", false},
		{"deadline before publication", context.DeadlineExceeded, 503, "not_published", false},
		{"uncertain", store.ErrRestorePublicationUncertain, 500, "uncertain", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previews := map[string]time.Time{"receipt": time.Now().Add(time.Minute)}
			w := httptest.NewRecorder()
			writeBackupRestoreResult(w, previews, "receipt", "restore_synthetic.db", tc.err)
			if w.Code != tc.status {
				t.Fatalf("status %d", w.Code)
			}
			var body map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["activated"] != false {
				t.Fatal("restore claimed activation")
			}
			if tc.outcome != "" && body["restoreOutcome"] != tc.outcome {
				t.Fatalf("wrong outcome: %v", body)
			}
			if tc.outcome == "not_published" {
				expectedReason := "restore_publication_failed"
				if tc.status == 503 {
					expectedReason = "restore_prepublication_cancelled"
				}
				if body["restoreReason"] != expectedReason {
					t.Fatal("wrong stable recovery reason")
				}
			} else if body["restoreReason"] != nil {
				t.Fatal("prepublication reason applied to another outcome")
			}
			if tc.err == nil && (body["status"] != "restored" || body["target"] != "restore_synthetic.db") {
				t.Fatal("durable result lost")
			}
			_, exists := previews["receipt"]
			if exists == tc.consumed {
				t.Fatal("wrong receipt policy")
			}
			if bytes.Contains(w.Body.Bytes(), []byte("private disk cause")) {
				t.Fatal("internal cause leaked")
			}
		})
	}
}

func TestBackupRestoreReservedWindowDeliversAlreadyCompletedResult(t *testing.T) {
	for _, tc := range []struct {
		name    string
		outcome error
		status  int
	}{
		{"success remains success", nil, 201},
		{"prepublication cancellation", context.DeadlineExceeded, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checked := make(chan bool, 1)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				withBackupDeadlines(w, r, 20*time.Millisecond, time.Second, func(w http.ResponseWriter, r *http.Request) {
					deadline, bounded := r.Context().Deadline()
					<-r.Context().Done()
					finalDeadline, stillBounded := r.Context().Deadline()
					// net/http can cancel its request context when the read deadline fires.
					// Preserve the original deadline; the cancellation enum is not renewal.
					checked <- bounded && stillBounded && deadline.Equal(finalDeadline) && r.Context().Err() != nil
					// The operation has already returned this result. No publication is started here.
					writeBackupRestoreResult(w, map[string]time.Time{}, "receipt", "restore_synthetic.db", tc.outcome)
				})
			}))
			defer srv.Close()
			response, err := srv.Client().Get(srv.URL)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != tc.status || !json.Valid(body) {
				t.Fatalf("wire result status=%d valid=%t", response.StatusCode, json.Valid(body))
			}
			if !<-checked {
				t.Fatal("operation deadline was renewed")
			}
		})
	}
}

func TestBackupRestoreCleanupCanExhaustReservedWindow(t *testing.T) {
	cleaned := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		withBackupDeadlines(w, r, 10*time.Millisecond, 20*time.Millisecond, func(w http.ResponseWriter, r *http.Request) {
			defer func() { time.Sleep(60 * time.Millisecond); close(cleaned) }()
			<-r.Context().Done()
			writeBackupRestoreResult(w, map[string]time.Time{}, "receipt", "restore_synthetic.db", nil)
		})
	}))
	defer srv.Close()
	response, err := srv.Client().Get(srv.URL)
	if err == nil {
		defer response.Body.Close()
		_, err = io.ReadAll(response.Body)
	}
	<-cleaned
	if err == nil {
		t.Fatal("buffered response unexpectedly delivered after window; test must not claim guaranteed receipt")
	}
}

// This composes real authentication, encrypted preview, target restore and HTTP
// receipt handling with a classified final-boundary fault. Store tests separately
// exercise physical publication faults; this is not filesystem-fault HTTP E2E.
func TestBackupRestoreComposedUncertainResultConsumesReceipt(t *testing.T) {
	testBackupRestoreComposedResult(t, "uncertain")
}
func TestBackupRestoreComposedDurableResultAfterDeadline(t *testing.T) {
	testBackupRestoreComposedResult(t, "deadline")
}
func TestBackupRestoreComposedPrepublicationRetainsReceipt(t *testing.T) {
	testBackupRestoreComposedResult(t, "prepublication")
}
func testBackupRestoreComposedResult(t *testing.T, mode string) {
	key := bytes.Repeat([]byte{91}, 32)
	live, err := store.Open(filepath.Join(t.TempDir(), "live.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	if err = live.Put("ledger", "fixture", map[string]string{"value": "before"}); err != nil {
		t.Fatal(err)
	}
	const pass = "synthetic-backup-result-password"
	archive, err := backup.Create(context.Background(), live, pass)
	if err != nil {
		t.Fatal(err)
	}
	if err = live.Put("ledger", "fixture", map[string]string{"value": "live after backup"}); err != nil {
		t.Fatal(err)
	}
	restoreDir := t.TempDir()
	const token = "012345678901234567890123456789012345"
	h := &server{s: live, opts: Options{AdminToken: token, BackupRestoreDir: restoreDir, BackupRestoreKey: key, BackupLimits: backup.Limits{Duration: 30 * time.Second}}}
	router := chi.NewRouter()
	router.Use(h.headers)
	calls := 0
	router.Route("/api", func(r chi.Router) {
		r.Use(h.authenticate, requireAdmin)
		h.registerBackupWithRestore(r, func(ctx context.Context, p *backup.Prepared, target string, key []byte) error {
			calls++
			if mode == "prepublication" && calls == 1 {
				return errors.New("synthetic prepublication refusal")
			}
			if err := p.Restore(ctx, target, key); err != nil {
				return err
			}
			if mode == "deadline" {
				original, ok := ctx.Deadline()
				if !ok {
					t.Error("operation deadline absent")
				}
				<-ctx.Done()
				after, ok := ctx.Deadline()
				if !ok || !after.Equal(original) {
					t.Error("operation deadline renewed")
				}
				return nil
			}
			if mode == "prepublication" {
				return nil
			}
			return &store.RestorePublicationUncertainError{Err: errors.New("synthetic final-boundary classification")}
		})
	})
	srv := httptest.NewServer(router)
	defer srv.Close()
	send := func(path string, input map[string]string, authorized bool) (int, map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(input)
		req, _ := http.NewRequest("POST", srv.URL+path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		if authorized {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body map[string]any
		if err = json.NewDecoder(res.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, body
	}
	input := map[string]string{"password": pass, "archive": base64.StdEncoding.EncodeToString(archive)}
	if status, _ := send("/api/admin/backups/restore", input, false); status != 401 || calls != 0 {
		t.Fatal("authentication bypassed")
	}
	status, summary := send("/api/admin/backups/preview", input, true)
	if status != 200 {
		t.Fatalf("preview status %d", status)
	}
	input["digest"] = summary["digest"].(string)
	input["confirmation"] = "RESTORE TO NEW STORE"
	status, result := send("/api/admin/backups/restore", input, true)
	expectedCalls := 1
	if mode == "prepublication" {
		if status != 500 || result["restoreOutcome"] != "not_published" || result["target"] != nil {
			t.Fatalf("wrong prepublication response: status%d", status)
		}
		entries, err := os.ReadDir(restoreDir)
		if err != nil || len(entries) != 0 {
			t.Fatal("prepublication refusal created a target")
		}
		// Same receipt, no new preview: a known prepublication failure retains it.
		status, result = send("/api/admin/backups/restore", input, true)
		expectedCalls = 2
	}
	if mode == "uncertain" {
		if status != 500 || result["restoreOutcome"] != "uncertain" {
			t.Fatalf("wrong uncertain wire result: status%d", status)
		}
	} else if status != 201 || result["status"] != "restored" {
		t.Fatalf("durable result not received: status%d", status)
	}
	if result["activated"] != false {
		t.Fatal("result claimed activation")
	}
	target, ok := result["target"].(string)
	if !ok || filepath.Base(target) != target || !strings.HasPrefix(target, "restore_") || !strings.HasSuffix(target, ".db") {
		t.Fatal("unsafe or absent target basename")
	}
	restored, err := store.Open(filepath.Join(restoreDir, target), key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var got map[string]string
	if err = restored.Get("ledger", "fixture", &got); err != nil || got["value"] != "before" {
		t.Fatal("target contents not restored")
	}
	if err = live.Get("ledger", "fixture", &got); err != nil || got["value"] != "live after backup" {
		t.Fatal("live store changed")
	}
	if status, _ = send("/api/admin/backups/restore", input, true); status != 409 || calls != expectedCalls {
		t.Fatal("uncertain receipt allowed direct replay")
	}
	entries, err := os.ReadDir(restoreDir)
	if err != nil {
		t.Fatal(err)
	}
	targets := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "restore_") && strings.HasSuffix(e.Name(), ".db") {
			targets++
		}
	}
	if targets != 1 {
		t.Fatalf("unexpected targets: %d", targets)
	}
}
