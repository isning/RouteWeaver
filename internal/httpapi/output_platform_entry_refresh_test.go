package httpapi_test

import (
	"reflect"
	"routeweaver/internal/httpapi"
	"routeweaver/internal/render"
	"strings"
	"testing"
)

// Uses the existing synthetic managed-entry HTTP fixture: no native process,
// real server application, or external credential is created by this test.
func TestOutputPreviewReportsPlatformEntryInputRefresh(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	f.ownerRequest("POST", "/me/outputs", map[string]any{
		"id": "refresh-phone", "name": "Phone", "profileId": "rotation-profile", "mode": "nodes-only",
	}, 201)
	f.rotate("credential-v2")
	f.queue("refresh-replacement")
	f.observe(0, false)
	f.observe(1, false)
	review := f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{
		"outputId": "refresh-phone",
	}, 200)
	if review["valid"] != true || review["previewScope"] != "output-update" || review["outputId"] != "refresh-phone" {
		t.Fatal("expected a valid selected-output review")
	}
	if digest, ok := review["previewDigest"].(string); !ok || len(digest) != 64 {
		t.Fatal("review is not bound to the existing publication digest")
	}
	for _, key := range []string{"routingSummary", "publishedRoutingSummary"} {
		summary, ok := review[key].(map[string]any)
		if !ok || summary["kind"] != "nodes-only" {
			t.Fatal("real nodes-only review must retain both routing summaries")
		}
	}
	refresh, ok := review["platformEntryRefresh"].(map[string]any)
	if !ok || len(refresh) != 2 || refresh["version"] != float64(1) || refresh["count"] != float64(1) {
		// Deliberately do not dump the whole preview or its technical artifact.
		t.Fatal("review must expose only version 1 and one refreshed platform entry")
	}
}

func TestOutputPreviewPlatformEntryRefreshPortableModes(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	for _, target := range []render.Target{{AdapterID: "mihomo", Version: render.MihomoVersion}, {AdapterID: "sing-box", Version: render.SingBoxVersion}} {
		for _, mode := range []render.OutputMode{render.NodesOnly, render.FullConfig} {
			id := target.AdapterID + "-" + string(mode)
			f.ownerRequest("POST", "/me/outputs", map[string]any{"id": id, "name": id, "profileId": "rotation-profile", "target": target, "mode": mode}, 201)
		}
	}
	f.rotate("credential-v2")
	f.queue("portable-refresh")
	f.observe(0, false)
	f.observe(1, false)
	for _, id := range []string{"mihomo-nodes-only", "mihomo-full", "sing-box-nodes-only", "sing-box-full"} {
		// OutputMode's wire value is full, not a UI label.
		t.Run(id, func(t *testing.T) {
			review := f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{"outputId": id}, 200)
			want := map[string]any{"version": float64(1), "count": float64(1)}
			if !reflect.DeepEqual(review["platformEntryRefresh"], want) {
				t.Fatal("portable mode lost the positive input refresh")
			}
			effect := review["publicationEffect"].(map[string]any)
			if effect["link"] != "preserve" {
				t.Fatal("input review altered publication effect")
			}
		})
	}
}

// Persisted edits below model historical/corrupt records only. Observation stays
// at the owner HTTP preview boundary; no internal comparison helper is tested.
func TestOutputPreviewOmitsUnprovenPlatformEntryRefresh(t *testing.T) {
	cases := []struct {
		name string
		edit func(*httpapi.Output)
	}{
		{"different-output-id", func(o *httpapi.Output) { o.ID = "different-output" }},
		{"invalid-output-id", func(o *httpapi.Output) { o.ID = "bad/output" }},
		{"uppercase-digest", func(o *httpapi.Output) {
			o.PlatformDependencies[0].ConnectionDigest = strings.ToUpper(o.PlatformDependencies[0].ConnectionDigest)
		}},
		{"missing-summary", func(o *httpapi.Output) { o.RoutingSummary = nil }},
		{"unknown-summary", func(o *httpapi.Output) { o.RoutingSummary.Version = 2 }},
		{"native-summary", func(o *httpapi.Output) { o.RoutingSummary.Kind = "native-override" }},
		{"contradictory-summary", func(o *httpapi.Output) { o.RoutingSummary.Kind = "advanced" }},
		{"unknown-intent", func(o *httpapi.Output) { o.RoutingIntent.Version = 2 }},
		{"native-intent", func(o *httpapi.Output) { o.RoutingIntent.Kind = "native-override" }},
		{"missing-dependencies", func(o *httpapi.Output) { o.PlatformDependencies = nil }},
		{"missing-version", func(o *httpapi.Output) { o.PlatformDependencies[0].CredentialVersion = "" }},
		{"invalid-version", func(o *httpapi.Output) { o.PlatformDependencies[0].CredentialVersion = "bad/version" }},
		{"missing-digest", func(o *httpapi.Output) { o.PlatformDependencies[0].ConnectionDigest = "" }},
		{"invalid-digest", func(o *httpapi.Output) { o.PlatformDependencies[0].ConnectionDigest = strings.Repeat("z", 64) }},
		{"duplicate", func(o *httpapi.Output) {
			o.PlatformDependencies = append(o.PlatformDependencies, o.PlatformDependencies[0])
		}},
		{"different-route", func(o *httpapi.Output) { o.PlatformDependencies[0].RouteID = "different-route" }},
		{"different-entry", func(o *httpapi.Output) { o.PlatformDependencies[0].ID = "different-entry" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newRotationRecoveryFixture(t)
			f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "guard-phone", "name": "Phone", "profileId": "rotation-profile", "mode": "nodes-only"}, 201)
			var frozen httpapi.Output
			if err := f.s.TenantGet(f.owner.id, "outputs", "guard-phone", &frozen); err != nil {
				t.Fatal(err)
			}
			tc.edit(&frozen)
			if err := f.s.TenantPut(f.owner.id, "outputs", "guard-phone", frozen); err != nil {
				t.Fatal(err)
			}
			f.rotate("credential-v2")
			f.queue("guard-refresh")
			f.observe(0, false)
			f.observe(1, false)
			review := f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{"outputId": "guard-phone"}, 200)
			if _, present := review["platformEntryRefresh"]; present {
				t.Fatal("unknown evidence became a positive refresh claim")
			}
		})
	}
}

func TestOutputPreviewPlatformEntryRefreshCountsInputsNotDeliveredBytes(t *testing.T) {
	for _, change := range []string{"version-only", "digest-only", "older-known-summary"} {
		t.Run(change, func(t *testing.T) {
			f := newRotationRecoveryFixture(t)
			f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "input-phone", "name": "Phone", "profileId": "rotation-profile", "mode": "nodes-only"}, 201)
			var frozen httpapi.Output
			if err := f.s.TenantGet(f.owner.id, "outputs", "input-phone", &frozen); err != nil {
				t.Fatal(err)
			}
			switch change {
			case "version-only":
				frozen.PlatformDependencies[0].CredentialVersion = "older-version"
			case "digest-only":
				frozen.PlatformDependencies[0].ConnectionDigest = strings.Repeat("0", 64)
			case "older-known-summary":
				frozen.RoutingIntent = nil
				frozen.PlatformDependencies[0].CredentialVersion = "older-version"
			}
			if err := f.s.TenantPut(f.owner.id, "outputs", frozen.ID, frozen); err != nil {
				t.Fatal(err)
			}
			review := f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{"outputId": frozen.ID}, 200)
			if !reflect.DeepEqual(review["platformEntryRefresh"], map[string]any{"version": float64(1), "count": float64(1)}) {
				t.Fatal("known refreshed input was lost")
			}
		})
	}
}

func TestOutputPreviewPlatformEntryRefreshDoesNotWriteOrLeakToOtherViews(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	created := f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "private-phone", "name": "Phone", "profileId": "rotation-profile", "mode": "nodes-only"}, 201)
	before := f.ownerRequest("GET", "/me/outputs/private-phone/status", nil, 200)
	unchanged := f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{"outputId": "private-phone"}, 200)
	if _, exists := unchanged["platformEntryRefresh"]; exists {
		t.Fatal("unchanged input must not produce a zero/positive claim")
	}
	f.rotate("credential-v2")
	f.queue("private-refresh")
	f.observe(0, false)
	f.observe(1, false)
	f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{"outputId": "private-phone"}, 200)
	after := f.ownerRequest("GET", "/me/outputs/private-phone/status", nil, 200)
	if before["revision"] != after["revision"] || created["id"] != after["id"] {
		t.Fatal("preview wrote publication state")
	}
	for _, path := range []string{"/me/outputs/private-phone/status", "/me/outputs/private-phone/comparison"} {
		view := f.ownerRequest("GET", path, nil, 200)
		if _, exists := view["platformEntryRefresh"]; exists {
			t.Fatal("review-only refresh escaped into another view")
		}
	}
	draft := f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{}, 200)
	if _, exists := draft["platformEntryRefresh"]; exists {
		t.Fatal("draft acquired existing-output refresh evidence")
	}
}

func TestOutputPreviewPlatformEntryRefreshCountsDistinctMatchingEntries(t *testing.T) {
	f := newRotationRecoveryFixture(t, "second-grant")
	var profile httpapi.Profile
	if err := f.s.TenantGet(f.owner.id, "profiles", "rotation-profile", &profile); err != nil {
		t.Fatal(err)
	}
	profile.PlatformEntryIDs = append(profile.PlatformEntryIDs, "second-grant")
	saveCurrentProfileDraft(t, f.owner, f.srv.URL+"/api/me/profiles/rotation-profile", profile)
	f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "two-phone", "name": "Phone", "profileId": "rotation-profile", "mode": "nodes-only"}, 201)
	f.rotate("credential-v2")
	f.rotateEntry("second-grant", "credential-v2")
	f.queue("two-refresh")
	f.observe(0, false)
	f.observe(1, false)
	var frozen httpapi.Output
	if err := f.s.TenantGet(f.owner.id, "outputs", "two-phone", &frozen); err != nil {
		t.Fatal(err)
	}
	frozen.PlatformDependencies[0], frozen.PlatformDependencies[1] = frozen.PlatformDependencies[1], frozen.PlatformDependencies[0]
	if err := f.s.TenantPut(f.owner.id, "outputs", frozen.ID, frozen); err != nil {
		t.Fatal(err)
	}
	review := f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{"outputId": "two-phone"}, 200)
	if !reflect.DeepEqual(review["platformEntryRefresh"], map[string]any{"version": float64(1), "count": float64(2)}) {
		t.Fatal("entry order must not change distinct refresh count")
	}
	frozen.PlatformDependencies[0].RouteID = "different-route"
	if err := f.s.TenantPut(f.owner.id, "outputs", frozen.ID, frozen); err != nil {
		t.Fatal(err)
	}
	review = f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{"outputId": "two-phone"}, 200)
	if !reflect.DeepEqual(review["platformEntryRefresh"], map[string]any{"version": float64(1), "count": float64(1)}) {
		t.Fatal("unmatched route must not hide or inflate the independently matched refresh")
	}
}

func TestOutputPreviewOmitsPlatformEntryRefreshForNativeCandidate(t *testing.T) {
	f := newRotationRecoveryFixture(t)
	f.ownerRequest("POST", "/me/outputs", map[string]any{"id": "native-phone", "name": "Phone", "profileId": "rotation-profile"}, 201)
	var profile httpapi.Profile
	if err := f.s.TenantGet(f.owner.id, "profiles", "rotation-profile", &profile); err != nil {
		t.Fatal(err)
	}
	profile.IR.NativeOverride = nativeProfile(profile.Target, `{"tcp-concurrent":true}`).IR.NativeOverride
	saveCurrentProfileDraft(t, f.owner, f.srv.URL+"/api/me/profiles/rotation-profile", profile)
	f.rotate("credential-v2")
	f.queue("native-refresh")
	f.observe(0, false)
	f.observe(1, false)
	review := f.ownerRequest("POST", "/me/profiles/rotation-profile/preview", map[string]any{"outputId": "native-phone"}, 200)
	if _, exists := review["platformEntryRefresh"]; exists {
		t.Fatal("native composition must not get portable refresh evidence")
	}
}
