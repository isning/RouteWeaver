package httpapi_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestBackupAdminPreviewConfirmAndFreshRestoreAtHTTPSeam(t *testing.T) {
	key := bytes.Repeat([]byte{41}, 32)
	s, err := store.Open(filepath.Join(t.TempDir(), "live.db"), key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.EnsureAdmin("operator", "synthetic-login-password"); err != nil {
		t.Fatal(err)
	}
	secret := "synthetic-recovery-secret" + strings.Repeat("x", 2<<20)
	if err = s.TenantPut("admin", "sources", "source1", map[string]string{"content": secret}); err != nil {
		t.Fatal(err)
	}
	restoreDir := filepath.Join(t.TempDir(), "restores")
	token := "012345678901234567890123456789012345"
	srv := httptest.NewServer(httpapi.NewWithOptions(s, render.Default(), httpapi.Options{AdminToken: token, BackupRestoreDir: restoreDir, BackupRestoreKey: key}))
	defer srv.Close()
	send := func(path string, v any, authorization string) (int, []byte, http.Header) {
		t.Helper()
		body, _ := json.Marshal(v)
		r, _ := http.NewRequest("POST", srv.URL+path, bytes.NewReader(body))
		if authorization != "" {
			r.Header.Set("Authorization", "Bearer "+authorization)
		}
		r.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, raw, res.Header
	}
	pass := "synthetic-backup-passphrase"
	status, raw, _ := send("/api/admin/backups", map[string]string{"password": pass}, "")
	if status != 401 {
		t.Fatalf("unauthorized: %d %s", status, raw)
	}
	user := inviteClient(t, s, srv, "backup-user")
	status, _, text := req(t, user.c, "POST", srv.URL+"/api/admin/backups", user.csrf, map[string]string{"password": pass})
	if status != 403 {
		t.Fatalf("tenant: %d %s", status, text)
	}
	account, err := s.Authenticate("operator", "synthetic-login-password", "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	_, sessionToken, err := s.NewSession(account, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"password": pass})
	csrfRequest, _ := http.NewRequest("POST", srv.URL+"/api/admin/backups", bytes.NewReader(body))
	csrfRequest.AddCookie(&http.Cookie{Name: "routeweaver_session", Value: sessionToken})
	response, err := http.DefaultClient.Do(csrfRequest)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("admin session bypassed CSRF")
	}
	status, encrypted, headers := send("/api/admin/backups", map[string]string{"password": pass}, token)
	if status != 200 || headers.Get("Content-Type") != "application/octet-stream" || !strings.Contains(headers.Get("Content-Disposition"), ".age") {
		t.Fatalf("download: %d %s", status, encrypted)
	}
	if bytes.Contains(encrypted, []byte(secret)) || headers.Get("Cache-Control") != "no-store" {
		t.Fatal("unencrypted or cacheable backup")
	}
	archive := base64.StdEncoding.EncodeToString(encrypted)
	if len(archive) <= 2<<20 {
		t.Fatal("large backup fixture must exercise the backup-specific request limit")
	}
	status, raw, _ = send("/api/admin/backups/preview", map[string]string{"password": "wrong-long-passphrase", "archive": archive}, token)
	if status != 400 {
		t.Fatalf("wrong password: %d %s", status, raw)
	}
	var rejected map[string]string
	if err = json.Unmarshal(raw, &rejected); err != nil || rejected["reason"] != "backup_archive_unverified" || rejected["detail"] != "backup cannot be authenticated or is incomplete; check the passphrase and file" {
		t.Fatalf("wrong-password recovery reason: %s (%v)", raw, err)
	}
	status, raw, _ = send("/api/admin/backups/preview", map[string]string{"password": pass, "archive": base64.StdEncoding.EncodeToString([]byte("incomplete archive"))}, token)
	rejected = nil
	if err = json.Unmarshal(raw, &rejected); status != 400 || err != nil || rejected["reason"] != "backup_archive_unverified" {
		t.Fatalf("unverified file has the same recovery reason: %d %s (%v)", status, raw, err)
	}
	status, raw, _ = send("/api/admin/backups/preview", map[string]string{"password": "short", "archive": archive}, token)
	rejected = nil
	if err = json.Unmarshal(raw, &rejected); status != 400 || err != nil || rejected["reason"] != "" || rejected["detail"] != "backup passphrase must contain at least 12 characters and at most 1024 bytes" {
		t.Fatalf("different validation failure keeps its detail: %d %s (%v)", status, raw, err)
	}
	if _, err = os.Stat(restoreDir); !os.IsNotExist(err) {
		t.Fatal("failed preview mutated filesystem")
	}
	status, raw, _ = send("/api/admin/backups/preview", map[string]string{"password": pass, "archive": archive}, token)
	if status != 200 {
		t.Fatalf("preview: %d %s", status, raw)
	}
	if bytes.Contains(raw, []byte(secret)) || bytes.Contains(raw, []byte(pass)) {
		t.Fatal("preview exposed secrets")
	}
	var preview struct {
		Digest           string `json:"digest"`
		RestoreAvailable bool   `json:"restoreAvailable"`
		Impact           struct {
			Mode              string `json:"mode"`
			ReplacesLiveStore bool   `json:"replacesLiveStore"`
		} `json:"impact"`
	}
	if err = json.Unmarshal(raw, &preview); err != nil {
		t.Fatal(err)
	}
	if preview.Digest == "" || !preview.RestoreAvailable || preview.Impact.Mode != "fresh-target" || preview.Impact.ReplacesLiveStore {
		t.Fatal("missing impact or target availability")
	}
	input := map[string]string{"password": pass, "archive": archive, "digest": preview.Digest}
	status, raw, _ = send("/api/admin/backups/restore", input, token)
	if status != 400 {
		t.Fatalf("missing confirmation: %d %s", status, raw)
	}
	input["confirmation"] = "RESTORE TO NEW STORE"
	input["digest"] = "different"
	status, raw, _ = send("/api/admin/backups/restore", input, token)
	if status != 409 {
		t.Fatalf("changed preview: %d %s", status, raw)
	}
	input["digest"] = preview.Digest
	input["target"] = "../../live.db"
	status, raw, _ = send("/api/admin/backups/restore", input, token)
	if status != 400 {
		t.Fatalf("path traversal: %d %s", status, raw)
	}
	delete(input, "target")
	if err = s.TenantPut("admin", "sources", "source1", map[string]string{"content": "new-live-state"}); err != nil {
		t.Fatal(err)
	}
	status, raw, _ = send("/api/admin/backups/restore", input, token)
	if status != 201 {
		t.Fatalf("restore: %d %s", status, raw)
	}
	var result struct {
		Status    string `json:"status"`
		Target    string `json:"target"`
		Activated bool   `json:"activated"`
	}
	json.Unmarshal(raw, &result)
	if result.Status != "restored" || result.Activated || filepath.Base(result.Target) != result.Target || !strings.HasSuffix(result.Target, ".db") {
		t.Fatalf("invalid restore result: %s", raw)
	}
	restored, err := store.Open(filepath.Join(restoreDir, result.Target), key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var v map[string]string
	if err = restored.TenantGet("admin", "sources", "source1", &v); err != nil || v["content"] != secret {
		t.Fatal("restored source not preserved")
	}
	if err = s.TenantGet("admin", "sources", "source1", &v); err != nil || v["content"] != "new-live-state" {
		t.Fatal("live source overwritten")
	}
	if _, err = restored.Authenticate("operator", "synthetic-login-password", "", time.Now()); err != nil {
		t.Fatal("restored identity unavailable:", err)
	}
	status, raw, _ = send("/api/admin/backups/restore", input, token)
	if status != 409 {
		t.Fatalf("restore replay accepted: %d %s", status, raw)
	}
	entries, err := os.ReadDir(restoreDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".restore-") {
			t.Fatal("private staging leak")
		}
	}
}
