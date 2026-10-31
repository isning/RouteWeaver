package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"routeweaver/internal/backup"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

type exportObservation struct {
	read, write   time.Time
	writes        int
	status        int
	path          string
	socketTimeout bool
}
type exportWindowWriter struct {
	http.ResponseWriter
	obs             *exportObservation
	slow            bool
	unsupportedAt   int
	cancelOnTighten context.CancelFunc
	socketTimeout   bool
}

func (w *exportWindowWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *exportWindowWriter) SetReadDeadline(d time.Time) error {
	w.obs.read = d
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(d)
}
func (w *exportWindowWriter) SetWriteDeadline(d time.Time) error {
	w.obs.writes++
	if w.unsupportedAt == w.obs.writes {
		return http.ErrNotSupported
	}
	if w.obs.writes == 2 && w.cancelOnTighten != nil {
		w.cancelOnTighten()
	}
	w.obs.write = d
	return http.NewResponseController(w.ResponseWriter).SetWriteDeadline(d)
}
func (w *exportWindowWriter) WriteHeader(status int) {
	w.obs.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *exportWindowWriter) Write(p []byte) (int, error) {
	if w.slow && w.obs.status == 200 {
		<-time.After(time.Until(w.obs.read.Add(40 * time.Millisecond)))
	}
	n, err := w.ResponseWriter.Write(p)
	if e, ok := err.(interface{ Timeout() bool }); ok && e.Timeout() {
		w.socketTimeout = true
	}
	return n, err
}

// The seam substitutes only final archive generation; real auth, decode, limits,
// private spool, response headers/deadlines and cleanup execute normally.
func TestBackupExportErrorOnlyWindow(t *testing.T) {
	const token = "012345678901234567890123456789012345"
	for _, mode := range []string{"deadline", "late_nil", "success", "slow_success", "unsupported_success", "unsupported_initial", "cancel_transition", "record_limit", "generic_error", "beyond_reserve", "unauthorized"} {
		t.Run(mode, func(t *testing.T) {
			observed := make(chan exportObservation, 1)
			h := &server{opts: Options{AdminToken: token, BackupLimits: backup.Limits{Duration: 100 * time.Millisecond}}}
			router := chi.NewRouter()
			router.Use(h.headers)
			obs := exportObservation{}
			calls := 0
			router.Route("/api", func(r chi.Router) {
				r.Use(h.authenticate, requireAdmin)
				h.registerBackupWithOperations(r, func(ctx context.Context, _ *store.Store, _ string, dst io.Writer, _ backup.Limits) error {
					calls++
					deadline, ok := ctx.Deadline()
					if !ok || !deadline.Equal(obs.read) {
						t.Error("operation/read deadline changed")
					}
					if f, ok := dst.(*os.File); ok {
						obs.path = f.Name()
					} else {
						t.Error("private spool bypassed")
					}
					if mode == "record_limit" {
						return store.ErrBackupRecordLimit
					}
					if mode == "generic_error" {
						return errors.New("synthetic failure")
					}
					if calls == 1 && (mode == "deadline" || mode == "late_nil" || mode == "beyond_reserve") {
						<-ctx.Done()
						if mode == "beyond_reserve" {
							<-time.After(1100 * time.Millisecond)
						}
						if mode != "late_nil" {
							return ctx.Err()
						}
					}
					_, err := io.WriteString(dst, strings.Repeat("encrypted fixture", 1024))
					return err
				}, func(context.Context, *backup.Prepared, string, []byte) error { return errors.New("unexpected restore") })
			})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				unsupportedAt := 0
				if mode == "unsupported_success" {
					unsupportedAt = 2
				}
				if mode == "unsupported_initial" {
					unsupportedAt = 1
				}
				wrapped := &exportWindowWriter{ResponseWriter: w, obs: &obs, slow: mode == "slow_success", unsupportedAt: unsupportedAt}
				if mode == "cancel_transition" {
					ctx, cancel := context.WithCancel(r.Context())
					defer cancel()
					r = r.WithContext(ctx)
					wrapped.cancelOnTighten = cancel
				}
				router.ServeHTTP(wrapped, r)
				obs.socketTimeout = wrapped.socketTimeout
				observed <- obs
			}))
			defer srv.Close()
			req, _ := http.NewRequest("POST", srv.URL+"/api/admin/backups", bytes.NewBufferString(`{"password":"synthetic-long-export-password"}`))
			req.Header.Set("Content-Type", "application/json")
			auth := token
			if mode == "unauthorized" {
				auth = "invalid"
			}
			req.Header.Set("Authorization", "Bearer "+auth)
			response, err := srv.Client().Do(req)
			var body []byte
			if response != nil {
				body, _ = io.ReadAll(response.Body)
				response.Body.Close()
			}
			got := <-observed
			if got.path != "" {
				if _, e := os.Stat(got.path); !os.IsNotExist(e) {
					t.Fatal("private spool not removed")
				}
			}
			switch mode {
			case "deadline", "late_nil":
				if err != nil || response.StatusCode != 503 {
					t.Fatalf("expected delivered503, response=%v error=%v", response, err)
				}
				var result struct {
					Reason string `json:"reason"`
				}
				if json.Unmarshal(body, &result) != nil || result.Reason != "backup_export_deadline_exceeded" {
					t.Fatalf("wrong error body:%s", body)
				}
				if got.write.Sub(got.read) != time.Second || got.writes != 1 {
					t.Fatal("error window not reserved upfront")
				}
			case "success":
				if err != nil || response.StatusCode != 200 || string(body) != strings.Repeat("encrypted fixture", 1024) {
					t.Fatal("success changed", err)
				}
				if !got.write.Equal(got.read) || got.writes != 2 {
					t.Fatal("successful copy received error reserve")
				}
			case "slow_success":
				if err == nil && len(body) == len(strings.Repeat("encrypted fixture", 1024)) {
					t.Fatal("slow success used reserved error window")
				}
				if !got.write.Equal(got.read) || got.writes != 2 || got.status != 200 || !got.socketTimeout || bytes.Contains(body, []byte(`"reason"`)) {
					t.Fatal("success deadline not enforced at socket", got)
				}
			case "unsupported_initial":
				if err != nil || response.StatusCode != 500 || calls != 0 {
					t.Fatal("unsupported initial deadline did not fail before generation", err)
				}
			case "cancel_transition":
				if err != nil || response.StatusCode != 400 || got.writes != 2 || bytes.Contains(body, []byte("backup_export_deadline_exceeded")) {
					t.Fatal("canceled transition reached success or was mislabeled", err)
				}
			case "record_limit", "generic_error":
				if err != nil || response.StatusCode != 400 || bytes.Contains(body, []byte("backup_export_deadline_exceeded")) {
					t.Fatal("nondeadline classification changed", err)
				}
			case "unsupported_success":
				if err != nil || response.StatusCode != 500 {
					t.Fatal("must fail closed before200", err)
				}
			case "beyond_reserve":
				if err == nil {
					t.Fatal("expired write deadline was renewed")
				}
				if got.writes != 1 {
					t.Fatal("late deadline mutation")
				}
			case "unauthorized":
				if err != nil || response.StatusCode != 401 || !got.read.IsZero() || got.writes != 0 || got.path != "" {
					t.Fatal("unauthorized request reached backup operation")
				}
			}
			if mode == "deadline" {
				obs = exportObservation{}
				retry, _ := http.NewRequest("POST", srv.URL+"/api/admin/backups", strings.NewReader(`{"password":"synthetic-long-export-password"}`))
				retry.Header.Set("Authorization", "Bearer "+token)
				retry.Header.Set("Content-Type", "application/json")
				res, e := srv.Client().Do(retry)
				if e != nil {
					t.Fatal("gate not released", e)
				}
				io.Copy(io.Discard, res.Body)
				res.Body.Close()
				retryObs := <-observed
				if res.StatusCode != 200 || calls != 2 || !retryObs.write.Equal(retryObs.read) {
					t.Fatal("retry after failed export did not complete")
				}
			}
		})
	}
}
