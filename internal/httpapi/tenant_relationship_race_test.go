package httpapi_test

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"routeweaver/internal/store"
	"strings"
	"testing"
	"time"
)

func TestDeleteSourceCreateCollectionRacePreservesReferences(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{11}, 32)
	s1, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s1.Close()
	s2, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	a1 := httptest.NewServer(httpapi.New(s1, render.Default(), "012345678901234567890123456789012345", ""))
	defer a1.Close()
	a2 := httptest.NewServer(httpapi.New(s2, render.Default(), "012345678901234567890123456789012345", ""))
	defer a2.Close()
	u := inviteClient(t, s1, a1, "audituser")
	src := map[string]any{"id": "src", "name": "Source", "kind": "text", "format": "uri-list", "content": "socks5://fixture-user:fixture-password@127.0.0.1:1080#Fixture", "enabled": true}
	code, _, raw := req(t, u.c, "POST", a1.URL+"/api/me/sources", u.csrf, src)
	if code != 200 {
		t.Fatal(code, raw)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec("UPDATE counters SET value=value WHERE kind='admission-lock'"); err != nil {
		t.Fatal(err)
	}
	type reply struct {
		code int
		raw  string
	}
	replies := make(chan reply, 2)
	go func() {
		c, _, r := req(t, u.c, "DELETE", a1.URL+"/api/me/sources/src", u.csrf, nil)
		replies <- reply{c, r}
	}()
	go func() {
		c, _, r := req(t, u.c, "POST", a2.URL+"/api/me/collections", u.csrf, map[string]any{"id": "coll", "name": "Collection", "sources": []any{map[string]any{"sourceId": "src", "steps": []any{}}}, "steps": []any{}})
		replies <- reply{c, r}
	}()
	time.Sleep(500 * time.Millisecond) // Both handlers can read WAL while their mutation waits on the real writer.
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	r1, r2 := <-replies, <-replies
	t.Logf("concurrent responses: %d %s; %d %s", r1.code, r1.raw, r2.code, r2.raw)
	var source, coll json.RawMessage
	sourceErr := s1.TenantGet(u.id, "sources", "src", &source)
	collErr := s1.TenantGet(u.id, "collections", "coll", &coll)
	t.Logf("source=%v collection=%v %s", sourceErr, collErr, coll)
	if sourceErr == store.ErrNotFound && collErr == nil {
		t.Fatal("successful collection references deleted source")
	}
	for _, response := range []reply{r1, r2} {
		if response.code != 200 && (response.code < 400 || response.code >= 500) {
			t.Fatalf("conflict must be a recoverable client refusal: %+v", response)
		}
	}
	if (r1.code == 200) == (r2.code == 200) {
		t.Fatal("exactly one conflicting mutation must succeed", r1, r2)
	}
	if collErr == store.ErrNotFound {
		return
	}
	c, _, r := req(t, u.c, "POST", a1.URL+"/api/me/collections/coll/preview", u.csrf, map[string]any{})
	t.Logf("saved collection preview: %d %s", c, r)
	if c != 200 {
		t.Fatal("surviving collection must have a valid source", c, r)
	}
}

// Each relationship uses two independent Store handles and HTTP servers. A
// held SQLite writer lets both handlers inspect their inputs before either can
// commit; only one conflicting mutation may be acknowledged.
func TestDeleteDependencyCreateProfileRacePreservesReferences(t *testing.T) {
	for _, relation := range []string{"source", "collection", "resource", "source-update", "collection-update", "resource-update", "profile-output"} {
		t.Run(relation, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "db")
			key := bytes.Repeat([]byte{11}, 32)
			s1, err := store.Open(path, key)
			if err != nil {
				t.Fatal(err)
			}
			defer s1.Close()
			s2, err := store.Open(path, key)
			if err != nil {
				t.Fatal(err)
			}
			defer s2.Close()
			a1 := httptest.NewServer(httpapi.New(s1, render.Default(), "012345678901234567890123456789012345", ""))
			defer a1.Close()
			a2 := httptest.NewServer(httpapi.New(s2, render.Default(), "012345678901234567890123456789012345", ""))
			defer a2.Close()
			u := inviteClient(t, s1, a1, "raceuser")
			setup := func(path string, body any, want int) {
				t.Helper()
				code, _, raw := req(t, u.c, "POST", a1.URL+"/api/me/"+path, u.csrf, body)
				if code != want {
					t.Fatalf("setup %s: %d %s", path, code, raw)
				}
			}
			p := templateTestProfile("dependent", render.Target{AdapterID: "mihomo", Version: render.MihomoVersion})
			target, dependent, endpoint, want := "sources/src", "profiles/dependent", "profiles", 200
			method := "POST"
			if strings.HasSuffix(relation, "-update") {
				setup("profiles", p, 200)
				relation = strings.TrimSuffix(relation, "-update")
				method, endpoint = "PUT", "profiles/dependent"
			}
			var body any = p
			if relation == "source" || relation == "collection" {
				setup("sources", map[string]any{"id": "src", "name": "Source", "kind": "text", "format": "uri-list", "content": "socks5://fixture-user:fixture-password@127.0.0.1:1080#Fixture", "enabled": true}, 200)
				p.SourceIDs = []string{"src"}
				if relation == "collection" {
					setup("collections", map[string]any{"id": "coll", "name": "Collection", "sources": []any{map[string]any{"sourceId": "src", "steps": []any{}}}, "steps": []any{}}, 200)
					p.SourceIDs = nil
					p.CollectionID = "coll"
					target = "collections/coll"
				}
				body = p
			} else if relation == "resource" {
				setup("resources/import", map[string]any{"resource": map[string]any{"id": "rules", "name": "Rules", "format": "mihomo-yaml", "behavior": "domain", "updatePolicy": "pinned"}, "contentBase64": base64.StdEncoding.EncodeToString([]byte("payload:\n  - '+.example.test'\n"))}, 201)
				p.IR.Resources = []domain.RuleResource{{ID: "rules"}}
				body = p
				target = "resources/rules"
			} else {
				setup("profiles", p, 200)
				target, dependent, endpoint, want = "profiles/dependent", "outputs/feed/access", "outputs", 201
				body = map[string]any{"id": "feed", "name": "Feed", "profileId": p.ID}
			}
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			if _, err = tx.Exec("UPDATE counters SET value=value WHERE kind='admission-lock'"); err != nil {
				t.Fatal(err)
			}
			type reply struct {
				code int
				raw  string
			}
			deleted, created := make(chan reply, 1), make(chan reply, 1)
			go func() {
				c, _, r := req(t, u.c, "DELETE", a1.URL+"/api/me/"+target, u.csrf, nil)
				deleted <- reply{c, r}
			}()
			go func() {
				c, _, r := req(t, u.c, method, a2.URL+"/api/me/"+endpoint, u.csrf, body)
				created <- reply{c, r}
			}()
			time.Sleep(500 * time.Millisecond)
			if err = tx.Commit(); err != nil {
				t.Fatal(err)
			}
			d, c := <-deleted, <-created
			if (d.code != 200 && (d.code < 400 || d.code >= 500)) || (c.code != want && (c.code < 400 || c.code >= 500)) {
				t.Fatalf("conflict must be recoverable: delete=%+v create=%+v", d, c)
			}
			if (d.code == 200) == (c.code == want) {
				t.Fatalf("exactly one mutation must succeed: delete=%+v create=%+v", d, c)
			}
			targetStatus, _, targetRaw := req(t, u.c, "GET", a1.URL+"/api/me/"+target, "", nil)
			dependentStatus, _, dependentRaw := req(t, u.c, "GET", a1.URL+"/api/me/"+dependent, "", nil)
			expectedDependent := 404
			if method == "PUT" {
				expectedDependent = 200
			}
			if d.code == 200 && (targetStatus != 404 || dependentStatus != expectedDependent) {
				t.Fatalf("delete winner: target=%d %s dependent=%d %s", targetStatus, targetRaw, dependentStatus, dependentRaw)
			}
			if d.code == 200 && method == "PUT" {
				var unchanged httpapi.Profile
				if err := json.Unmarshal([]byte(dependentRaw), &unchanged); err != nil {
					t.Fatal(err)
				}
				if len(unchanged.SourceIDs) != 0 || unchanged.CollectionID != "" || len(unchanged.IR.Resources) != 0 {
					t.Fatal("rejected update changed profile references")
				}
			}
			if c.code == want && (targetStatus != 200 || dependentStatus != 200) {
				t.Fatalf("create winner: target=%d %s dependent=%d %s", targetStatus, targetRaw, dependentStatus, dependentRaw)
			}
		})
	}
}
