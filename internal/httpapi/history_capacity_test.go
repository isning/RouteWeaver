package httpapi_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"testing"
)

func TestHistoryCapacityRequiresAdminAndExposesOnlyBoundedCounts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private-capacity.db")
	s, err := store.Open(path, bytes.Repeat([]byte{44}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.EnsureAdmin("operator", "synthetic-login-password"); err != nil {
		t.Fatal(err)
	}
	if err = s.TenantPut("secret-owner", "sources", "private-id", map[string]string{"secret": "must-not-leak"}); err != nil {
		t.Fatal(err)
	}
	token := "012345678901234567890123456789012345"
	srv := httptest.NewServer(httpapi.NewWithOptions(s, render.Default(), httpapi.Options{AdminToken: token, BackupLimits: backup.Limits{Rows: 10}}))
	defer srv.Close()
	endpoint := srv.URL + "/api/admin/backups/capacity"
	res, err := http.Get(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatalf("anonymous: %d", res.StatusCode)
	}
	user := inviteClient(t, s, srv, "capacity-user")
	status, _, raw := req(t, user.c, "GET", endpoint, user.csrf, nil)
	if status != 403 {
		t.Fatalf("tenant: %d %s", status, raw)
	}
	request, _ := http.NewRequest("GET", endpoint, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	res, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("admin: %d %s", res.StatusCode, body)
	}
	for _, secret := range []string{path, "secret-owner", "private-id", "must-not-leak"} {
		if bytes.Contains(body, []byte(secret)) {
			t.Fatalf("inventory leaked %q", secret)
		}
	}
	var got store.HistoryCapacity
	if err = json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.BackupRows.Limit != 10 || got.BackupRows.Count > 11 || got.ArchiveBytes != nil || got.WarningPercent != 80 {
		t.Fatalf("limits/unknown: %+v", got)
	}
}
