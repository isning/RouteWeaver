package httpapi_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/httpapi"
)

func TestPrivateFrozenRoutingIntentFitsExistingRecordAt24MiBEdge(t *testing.T) {
	for _, coverage := range []string{"partial", "unavailable"} {
		t.Run(coverage, func(t *testing.T) {
			s, srv := makeServer(t)
			u := inviteClient(t, s, srv, "intent-record-edge")
			p := privateIntentProfile()
			code, _, _ := req(t, u.c, "POST", srv.URL+"/api/me/profiles", u.csrf, p)
			if code != 200 {
				t.Fatalf("profile: %d", code)
			}
			code, _, _ = req(t, u.c, "POST", srv.URL+"/api/me/outputs", u.csrf, map[string]any{"id": "edge", "name": "Edge", "profileId": p.ID})
			if code != 201 {
				t.Fatalf("initial publication: %d", code)
			}
			var published httpapi.Output
			if err := s.TenantGet(u.id, "outputs", "edge", &published); err != nil {
				t.Fatal(err)
			}
			originalArtifacts := published.Artifacts
			originalToken := published.Token
			originalRevision := published.Revision
			complete := published.RoutingIntent
			minimal := *complete
			portable := *complete.FrozenPortableRoutingIntent
			portable.Rules = []httpapi.FrozenRoutingRule{}
			portable.OmittedRuleCount = portable.RuleCount
			minimal.FrozenPortableRoutingIntent = &portable
			encodedMinimal, err := json.Marshal(minimal)
			if err != nil {
				t.Fatal(err)
			}
			// Use a persisted-record fixture to put the actual JSON record at its
			// existing limit without requiring pathological renderer input or bypassing
			// request admission in production. Only the fixture pads metadata; owner
			// preview and publication still run through their real HTTP contracts.
			// The publication predates private detail and retains its exact artifact.
			headroom := len(encodedMinimal) + len(`,"routingIntent":`) + 32
			if coverage == "unavailable" {
				headroom = 32
			}
			published.RoutingIntent = nil
			published.SemanticSnapshot = nil // Historical fixture predates optional semantic metadata too.
			published.Name = ""
			encoded, err := json.Marshal(published)
			if err != nil {
				t.Fatal(err)
			}
			published.Name = strings.Repeat("n", (24<<20)-len(encoded)-headroom)
			encoded, err = json.Marshal(published)
			if err != nil || len(encoded) != (24<<20)-headroom {
				t.Fatal("fixture did not reach actual record edge")
			}
			if err = s.TenantPut(u.id, "outputs", "edge", published); err != nil {
				t.Fatal(err)
			}
			code, review, _ := req(t, u.c, "POST", srv.URL+"/api/me/profiles/"+p.ID+"/preview", u.csrf, map[string]any{"outputId": "edge"})
			if code != 200 {
				t.Fatalf("private display enrichment rejected a previously admissible output: status %d", code)
			}
			if coverage == "partial" {
				intent := ownerRoutingIntent(t, review, "routingIntent")
				if intent["ruleCount"] != float64(1) || intent["omittedRuleCount"] != float64(1) || len(intent["rules"].([]any)) != 0 || intent["defaultAction"] == nil {
					t.Fatal("record-edge omission did not retain explicit coverage/default")
				}
			} else if review["routingIntent"] != nil {
				t.Fatal("a view that cannot fit must be unavailable, not a misleading empty policy")
			}
			if review["publishedRoutingIntent"] != nil {
				t.Fatal("preview backfilled historical absence")
			}
			code, _, _ = req(t, u.c, "POST", srv.URL+"/api/me/outputs/edge/publish", u.csrf, map[string]any{"previewDigest": review["previewDigest"]})
			if code != 200 {
				t.Fatalf("reviewed edge publication: %d", code)
			}
			var after httpapi.Output
			if err = s.TenantGet(u.id, "outputs", "edge", &after); err != nil {
				t.Fatal(err)
			}
			encoded, err = json.Marshal(after)
			if err != nil || len(encoded) > 24<<20 {
				t.Fatalf("stored output exceeded actual record limit: %d", len(encoded))
			}
			if !reflect.DeepEqual(after.Artifacts, originalArtifacts) || after.Token != originalToken || after.Revision == originalRevision {
				t.Fatal("summary budget changed the artifact/link or failed explicit publication")
			}
			if coverage == "partial" {
				if after.RoutingIntent == nil || after.RoutingIntent.OmittedRuleCount != 1 || len(after.RoutingIntent.Rules) != 0 {
					t.Fatal("publication did not freeze the reviewed partial snapshot")
				}
			} else if after.RoutingIntent != nil {
				t.Fatal("publication invented unavailable detail")
			}
		})
	}
}
