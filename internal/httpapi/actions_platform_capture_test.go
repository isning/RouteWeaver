package httpapi

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/render"
	"routeweaver/internal/service"
	"routeweaver/internal/store"
)

func platformCaptureFixture(t *testing.T) (*server, Output) {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "synthetic.db"), make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	h := &server{s: s}
	put := func(kind, id string, value any) {
		t.Helper()
		if err := s.Put(kind, id, value); err != nil {
			t.Fatal(err)
		}
	}
	put("users", "owner", domain.User{ID: "owner", Name: "Synthetic", Enabled: true, QuotaBytes: 1 << 30})
	put("accounts", "owner", store.Account{ID: "owner"})
	put("routes", "route", domain.Route{ID: "route", Name: "Synthetic route", UserIDs: []string{"owner"}})
	grant := PublicEntryGrant{ID: "entry", Name: "Entry", UserID: "owner", RouteID: "route", CredentialVersion: "v1", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.10", Port: 1080}}
	if err := s.TenantPut("owner", "platform-entries", "entry", grant); err != nil {
		t.Fatal(err)
	}
	target := render.Target{AdapterID: "mihomo", Version: render.MihomoVersion}
	p := Profile{ID: "profile", Name: "Profile", Target: target, Mode: render.FullConfig, PlatformEntryIDs: []string{"entry"}, IR: domain.ClientProfileIR{SchemaVersion: "1.0", ID: "profile", Name: "Profile", OwnerID: "owner", Revision: "1", DefaultAction: domain.ActionRef{Kind: "endpoint", Ref: "entry"}}}
	if err := s.TenantPut("owner", "profiles", "profile", p); err != nil {
		t.Fatal(err)
	}
	output := Output{ID: "output", Name: "Output", ProfileID: p.ID, Target: target, Mode: render.FullConfig, Status: "published", Revision: "published-v1"}
	if err := s.TenantPut("owner", "outputs", output.ID, output); err != nil {
		t.Fatal(err)
	}
	budget := 2 << 20
	snapshot, err := s.PlatformComparisonSnapshot(context.Background(), "owner", time.Now(), &budget)
	if err != nil {
		t.Fatal(err)
	}
	inputs := newTemplateInputs(s)
	inputs.platform = &platformComparisonReader{snapshot: snapshot}
	prepared, err := h.prepareOutput("owner", output, inputs)
	if err != nil {
		t.Fatal(err)
	}
	output = prepared.output
	if err := s.TenantPut("owner", "outputs", output.ID, output); err != nil {
		t.Fatal(err)
	}
	var storedOutput Output
	if err := s.TenantGet("owner", "outputs", output.ID, &storedOutput); err != nil {
		t.Fatal(err)
	}
	output = storedOutput
	grant.Connection.Port = 1081
	if err := s.TenantPut("owner", "platform-entries", grant.ID, grant); err != nil {
		t.Fatal(err)
	}
	return h, output
}

func TestSmallPlatformComparisonSecondCaptureFencesChanges(t *testing.T) {
	for _, mode := range []string{"stable", "grant", "account", "quota", "hold", "output", "profile", "membership", "capture-clock", "stale-capture"} {
		t.Run(mode, func(t *testing.T) {
			h, output := platformCaptureFixture(t)
			budget := 2 << 20
			calls := 0
			capture := func(ctx context.Context, owner string, now time.Time, budget *int) (*store.PlatformComparisonSnapshot, error) {
				calls++
				if calls == 2 {
					var err error
					switch mode {
					case "grant":
						var v PublicEntryGrant
						err = h.s.TenantGet(owner, "platform-entries", "entry", &v)
						if err == nil {
							v.Revoked = true
							err = h.s.TenantPut(owner, "platform-entries", "entry", v)
						}
					case "account":
						err = h.s.Put("accounts", owner, store.Account{ID: owner, Disabled: true})
					case "quota":
						var u domain.User
						err = h.s.Get("users", owner, &u)
						if err == nil {
							u.QuotaBytes = 0
							err = h.s.Put("users", owner, u)
						}
					case "hold":
						err = h.s.Put("accounting-holds", "hold", store.AccountingHold{UserID: owner})
					case "output":
						v := output
						v.Revision = "concurrent-v2"
						err = h.s.TenantPut(owner, "outputs", v.ID, v)
					case "profile":
						var p Profile
						err = h.s.TenantGet(owner, "profiles", "profile", &p)
						if err == nil {
							p.Name = "Concurrent draft"
							err = h.s.TenantPut(owner, "profiles", "profile", p)
						}
					case "membership":
						err = h.s.Put("agent-observations", "new", map[string]any{})
					case "capture-clock":
						now = now.Add(2 * time.Hour)
					}
					if err != nil {
						return nil, err
					}
				}
				if mode == "stale-capture" && calls == 1 {
					now = now.Add(-2 * time.Minute)
				}
				return h.s.PlatformComparisonSnapshot(ctx, owner, now, budget)
			}
			if mode == "capture-clock" {
				expiry := time.Now().Add(time.Hour)
				if err := h.s.Put("entitlements", "owner", service.Entitlement{UserID: "owner", ExpiresAt: &expiry, Cycle: service.CyclePolicy{Mode: "none", Timezone: "UTC+8"}}); err != nil {
					t.Fatal(err)
				}
			}
			result := h.compareSmallPlatformDraftUsing(context.Background(), "owner", output, &budget, capture)
			if calls != 2 {
				t.Fatalf("did not reach post-render capture: %d, %v", calls, result)
			}
			want := "unavailable"
			if mode == "stable" {
				want = "changed"
			}
			if result["state"] != want {
				t.Fatalf("want %s got %v", want, result)
			}
			if mode != "output" {
				var after Output
				if err := h.s.TenantGet("owner", "outputs", output.ID, &after); err != nil || !reflect.DeepEqual(output, after) {
					t.Fatalf("comparison rewrote publication: %v", err)
				}
			}
		})
	}
}

func TestSmallPlatformComparisonRejectsProfileKeyPayloadMismatch(t *testing.T) {
	h, output := platformCaptureFixture(t)
	var p Profile
	if err := h.s.TenantGet("owner", "profiles", output.ProfileID, &p); err != nil {
		t.Fatal(err)
	}
	p.ID = "different-profile"
	if err := h.s.TenantPut("owner", "profiles", output.ProfileID, p); err != nil {
		t.Fatal(err)
	}
	budget := 2 << 20
	calls := 0
	capture := func(ctx context.Context, owner string, now time.Time, budget *int) (*store.PlatformComparisonSnapshot, error) {
		calls++
		return h.s.PlatformComparisonSnapshot(ctx, owner, now, budget)
	}
	result := h.compareSmallPlatformDraftUsing(context.Background(), "owner", output, &budget, capture)
	if result["state"] != "unavailable" || calls != 1 {
		t.Fatalf("mismatched profile admitted: %v, captures %d", result, calls)
	}
}

func TestSmallPlatformComparisonSourceCollectionCaptureFence(t *testing.T) {
	for _, mode := range []string{"stable", "source-value", "source-membership", "collection-value", "collection-membership"} {
		t.Run(mode, func(t *testing.T) {
			h, output := platformCaptureFixture(t)
			put := func(kind, id string, v any) {
				t.Helper()
				if err := h.s.TenantPut("owner", kind, id, v); err != nil {
					t.Fatal(err)
				}
			}
			source := Source{ID: "source", OwnerID: "owner", Name: "Source", Enabled: true, Snapshot: &domain.SourceSnapshot{SourceID: "source", SnapshotID: "s1", OwnerID: "owner", SourceName: "Source", Endpoints: []domain.ClientEndpoint{{ID: "import", Name: "Imported", Origin: "imported", OwnerID: "owner", Connection: domain.Connection{Protocol: "socks", Host: "192.0.2.20", Port: 1080}}}}}
			collection := domain.Collection{ID: "collection", OwnerID: "owner", Name: "Collection", Sources: []domain.CollectionSource{{SourceID: "source"}}}
			put("sources", "source", source)
			put("collections", "collection", collection)
			var p Profile
			if err := h.s.TenantGet("owner", "profiles", "profile", &p); err != nil {
				t.Fatal(err)
			}
			p.CollectionID = "collection"
			put("profiles", "profile", p)
			calls := 0
			budget := 2 << 20
			capture := func(ctx context.Context, owner string, now time.Time, budget *int) (*store.PlatformComparisonSnapshot, error) {
				calls++
				if calls == 2 {
					switch mode {
					case "source-value":
						source.Snapshot.Endpoints[0].Connection.Port = 1090
						put("sources", "source", source)
					case "source-membership":
						source.ID = "other"
						put("sources", "other", source)
					case "collection-value":
						collection.Steps = []domain.ProcessingStep{{ID: "rename", Enabled: true, Kind: "rename", Template: "Different"}}
						put("collections", "collection", collection)
					case "collection-membership":
						collection.ID = "other"
						put("collections", "other", collection)
					}
				}
				return h.s.PlatformComparisonSnapshot(ctx, owner, now, budget)
			}
			got := h.compareSmallPlatformDraftUsing(context.Background(), "owner", output, &budget, capture)
			want := "unavailable"
			if mode == "stable" {
				want = "changed"
			}
			if got["state"] != want || calls != 2 {
				t.Fatalf("state=%v calls=%d want=%s", got, calls, want)
			}
			var after Output
			if err := h.s.TenantGet("owner", "outputs", output.ID, &after); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(output, after) {
				t.Fatal("publication mutated")
			}
		})
	}
}
