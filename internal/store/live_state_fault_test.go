package store_test

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"fmt"
	"routeweaver/internal/domain"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// Infrastructure-only canonical SQL bypass tests. The owner separately covers
// the documented derived-state fault seam. All assertions use public admission.
func TestLiveStateRawDeleteReinsertInvalidatesWarmDomain(t *testing.T) {
	for _, kind := range []string{"entry-admission-leases", "admission-budgets"} {
		t.Run(kind, func(t *testing.T) {
			s, path, _, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 100)
			liveWarm(t, s, scope, now)
			reason := "quota-budget-pending"
			var value any = liveBudget("account", "embedded", 40, 0, true, now)
			if kind == "entry-admission-leases" {
				reason = "ip-limit"
				value = map[string]any{"id": "embedded", "binding": store.EntryAdmissionBinding{UserID: "account"}, "clientIp": "192.0.2.8", "expiresAt": now.Add(time.Hour)}
			}
			livePut(t, s, kind, "raw-bypass", value)
			in := admissionRequest("entry1", "192.0.2.1", "probe")
			liveExpect(t, s, scope, in, now, reason)
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			var encrypted []byte
			if err = db.QueryRow(`SELECT data FROM records WHERE kind=? AND id='raw-bypass'`, kind).Scan(&encrypted); err != nil {
				t.Fatal(err)
			}
			if _, err = db.Exec(`DELETE FROM records WHERE kind=? AND id='raw-bypass'`, kind); err != nil {
				t.Fatal(err)
			}
			liveExpect(t, s, scope, in, now, "")
			in.Final = true
			liveExpect(t, s, scope, in, now, "presence-closed")
			if _, err = db.Exec(`INSERT INTO records(kind,id,data) VALUES(?,'raw-bypass',?)`, kind, encrypted); err != nil {
				t.Fatal(err)
			}
			liveExpect(t, s, scope, admissionRequest("entry1", "192.0.2.1", "after-reinsert"), now, reason)
		})
	}
}

func TestLiveStateCanonicalAuthenticationAndRawJSONPrecedePending(t *testing.T) {
	for _, fault := range []string{"ciphertext", "raw-json"} {
		t.Run(fault, func(t *testing.T) {
			s, path, key, scope, now := admissionFixture(t)
			finiteAdmissionPlan(t, s, 100)
			liveWarm(t, s, scope, now)
			livePut(t, s, "admission-budgets", "a-pending", liveBudget("account", "pending", 1, 0, true, now))
			livePut(t, s, "admission-budgets", "z-corrupt", liveBudget("foreign", "foreign", 1, 0, true, now.Add(time.Hour)))
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			payload := []byte{0}
			if fault == "raw-json" {
				block, err := aes.NewCipher(key)
				if err != nil {
					t.Fatal(err)
				}
				aead, err := cipher.NewGCM(block)
				if err != nil {
					t.Fatal(err)
				}
				nonce := make([]byte, aead.NonceSize())
				if _, err = rand.Read(nonce); err != nil {
					t.Fatal(err)
				}
				payload = aead.Seal(nonce, nonce, []byte(`{"invalid":`), []byte("admission-budgets/z-corrupt"))
			}
			if _, err = db.Exec(`UPDATE records SET data=? WHERE kind='admission-budgets' AND id='z-corrupt'`, payload); err != nil {
				t.Fatal(err)
			}
			v, err := s.AcquireAdmission(scope, admissionRequest("entry1", "192.0.2.1", "probe"), now)
			if err == nil {
				t.Fatalf("%s was hidden by pending: %+v", fault, v)
			}
			want := "corrupt encrypted record"
			if fault == "raw-json" {
				want = "unexpected end of JSON input"
			}
			if fmt.Sprint(err) != want {
				t.Fatalf("want %q, got %v", want, err)
			}
		})
	}
}

func TestLiveStateRawDirtyRebuildDoesNotLeavePeerAccountStale(t *testing.T) {
	s, path, _, scope, now := admissionFixture(t)
	finiteAdmissionPlan(t, s, 100)
	if err := s.PutUser(domain.User{ID: "peer", Name: "Peer", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	livePut(t, s, "entitlements", "peer", service.Entitlement{UserID: "peer", ServiceID: "plan", StartsAt: now.Add(-time.Hour), Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}})
	if err := s.TenantPut("peer", "platform-entries", "entry2", map[string]any{"id": "entry2", "userId": "peer", "routeId": "route", "credentialVersion": "v1"}); err != nil {
		t.Fatal(err)
	}
	livePut(t, s, "entry-admission-bindings", "instance:entry2:subject:v1", store.EntryAdmissionBinding{ID: "entry2", InstanceID: scope.InstanceID, EntryID: "entry2", SubjectID: "subject", UserID: "peer", RouteID: "route", GrantID: "entry2", CredentialVersion: "v1"})
	for _, owner := range []string{"account", "peer"} {
		livePut(t, s, "admission-budgets", owner, liveBudget(owner, owner, 30, 0, true, now.Add(time.Hour)))
	}
	sequence := 0
	check := func(entry string, want uint64) {
		t.Helper()
		sequence++
		in := admissionRequest(entry, "192.0.2.1", fmt.Sprintf("probe-%d", sequence))
		v := liveExpect(t, s, scope, in, now, "")
		if v.ByteBudget == nil || *v.ByteBudget != want {
			t.Fatalf("%s want %d: %+v", entry, want, v)
		}
		in.Final = true
		liveExpect(t, s, scope, in, now, "presence-closed")
	}
	check("entry1", 70)
	check("entry2", 70)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`DELETE FROM records WHERE kind='admission-budgets' AND id='account'`); err != nil {
		t.Fatal(err)
	}
	// The unaffected peer is rebuilt first. Acknowledging dirty must not keep the
	// old account's previously warm reservation around.
	check("entry2", 70)
	check("entry1", 100)
}
