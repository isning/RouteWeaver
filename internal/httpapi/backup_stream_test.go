package httpapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestBackupMultipartLargeArchiveAndEndpointDeadlines(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{71}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	detail := strings.Repeat("synthetic-ledger-value", 3400)
	for i := 0; i < 300; i++ {
		if err = s.Put("ledger", fmt.Sprintf("entry-%04d", i), map[string]any{"sequence": i, "detail": detail}); err != nil {
			t.Fatal(err)
		}
	}
	token := "012345678901234567890123456789012345"
	restoreDir := t.TempDir()
	srv := httptest.NewUnstartedServer(httpapi.NewWithOptions(s, render.Default(), httpapi.Options{AdminToken: token, BackupRestoreDir: restoreDir, BackupRestoreKey: bytes.Repeat([]byte{72}, 32), BackupLimits: backup.Limits{Duration: 30 * time.Second}}))
	srv.Config.ReadTimeout = 50 * time.Millisecond
	srv.Config.WriteTimeout = 50 * time.Millisecond
	srv.Start()
	defer srv.Close()
	pass := "synthetic-long-backup-passphrase"
	// This request and response exceed the ordinary server deadline. Only the
	// authenticated backup handler extends it to the configured bounded duration.
	reader, writer := io.Pipe()
	go func() {
		fmt.Fprint(writer, `{"password":"`)
		time.Sleep(150 * time.Millisecond)
		fmt.Fprint(writer, pass+`"}`)
		writer.Close()
	}()
	req, _ := http.NewRequest("POST", srv.URL+"/api/admin/backups", reader)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal("backup ordinary deadline not extended:", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("export%d:%s", res.StatusCode, body)
	}
	file, err := os.CreateTemp(t.TempDir(), "download-*.age")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	n, err := io.Copy(file, res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if n <= 16<<20 || res.ContentLength != n {
		t.Fatalf("expected complete large fixed-length download: %d %d", n, res.ContentLength)
	}
	upload := func(path string, metadata map[string]string, extra bool) (int, []byte) {
		t.Helper()
		file.Seek(0, 0)
		r, w := io.Pipe()
		mw := multipart.NewWriter(w)
		contentType := mw.FormDataContentType()
		go func() {
			field, e := mw.CreateFormField("metadata")
			if e == nil {
				e = json.NewEncoder(field).Encode(metadata)
			}
			if e == nil {
				time.Sleep(100 * time.Millisecond)
				var part io.Writer
				part, e = mw.CreateFormFile("archive", "backup.age")
				if e == nil {
					_, e = io.Copy(part, file)
				}
			}
			if e == nil && extra {
				e = mw.WriteField("unexpected", "reject")
			}
			if e == nil {
				e = mw.Close()
			}
			w.CloseWithError(e)
		}()
		req, _ := http.NewRequest("POST", srv.URL+path, r)
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("Authorization", "Bearer "+token)
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		body, e := io.ReadAll(res.Body)
		if e != nil {
			t.Fatal(e)
		}
		return res.StatusCode, body
	}
	status, body := upload("/api/admin/backups/preview", map[string]string{"password": pass}, false)
	if status != 200 {
		t.Fatalf("multipart preview%d:%s", status, body)
	}
	var summary backup.Summary
	if err = json.Unmarshal(body, &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Manifest.Version != 2 || summary.Counts["ledger"] != 300 {
		t.Fatalf("bad manifest:%s", body)
	}
	status, body = upload("/api/admin/backups/preview", map[string]string{"password": pass}, true)
	if status != 400 {
		t.Fatalf("extra part accepted%d:%s", status, body)
	}
	metadata := map[string]string{"password": pass, "digest": summary.Digest, "confirmation": "RESTORE TO NEW STORE"}
	status, body = upload("/api/admin/backups/restore", metadata, false)
	if status != 201 {
		t.Fatalf("multipart restore%d:%s", status, body)
	}
	var result struct {
		Target    string
		Activated bool
	}
	if err = json.Unmarshal(body, &result); err != nil || result.Activated {
		t.Fatalf("unexpected activation:%s", body)
	}
	restored, err := store.Open(filepath.Join(restoreDir, result.Target), bytes.Repeat([]byte{72}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var got struct {
		Sequence int
		Detail   string
	}
	if err = restored.Get("ledger", "entry-0299", &got); err != nil || got.Sequence != 299 || got.Detail != detail {
		t.Fatal("last record lost")
	}
	status, body = upload("/api/admin/backups/restore", metadata, false)
	if status != 409 {
		t.Fatalf("multipart replay%d:%s", status, body)
	}
}
