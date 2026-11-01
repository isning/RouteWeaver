package httpapi

import (
	"context"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"
	"net/http/httptest"
	"routeweaver/internal/backup"
	"routeweaver/internal/store"
	"strings"
	"testing"
)

func TestHistoryCapacitySharesBoundedBackupOperationGate(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	h := &server{}
	r := chi.NewRouter()
	h.registerBackupWithOperations(r, func(context.Context, *store.Store, string, io.Writer, backup.Limits) error {
		close(entered)
		<-release
		return context.Canceled
	}, nil)
	srv := httptest.NewServer(r)
	defer srv.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		res, err := http.Post(srv.URL+"/admin/backups", "application/json", strings.NewReader(`{"password":"synthetic-long-backup-password"}`))
		if err == nil {
			res.Body.Close()
		}
	}()
	<-entered
	res, err := http.Get(srv.URL + "/admin/backups/capacity")
	close(release)
	<-done
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 429 {
		t.Fatalf("concurrent inventory not bounded: %d", res.StatusCode)
	}
}
