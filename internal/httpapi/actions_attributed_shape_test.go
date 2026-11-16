package httpapi

import (
	"context"
	"routeweaver/internal/domain"
	"testing"
	"time"
)

func TestAttributionShapeFrozenMappingAndIndependentRevision(t *testing.T) {
	for _, mode := range []string{"normal", "publication-revision", "swapped", "duplicate", "extra", "missing", "repeated-profile-id", "source", "collection", "imported-endpoint", "frozen-plan-swap", "frozen-plan-duplicate", "other-owner"} {
		t.Run(mode, func(t *testing.T) {
			h, out := platformCaptureFixture(t)
			p := Profile{ID: "profile", PlatformEntryIDs: []string{"original-a", "original-b"}}
			p.IR.Endpoints = []domain.ClientEndpoint{{ID: "original-a", Origin: "platform-entry"}, {ID: "original-b", Origin: "platform-entry"}}
			out.Attribution = &outputAttribution{Revision: "attribution-v1", Grants: map[string]string{"original-a": "isolated-a", "original-b": "isolated-b"}}
			// Provisioning captures a separate map: later output mutation must not mutate
			// the frozen association in this test through a shared Go map pointer.
			frozen := out
			frozen.Attribution = &outputAttribution{Revision: "attribution-v1", Grants: map[string]string{"original-a": "isolated-a", "original-b": "isolated-b"}}
			intent := attributedOutputIntent{ID: out.ID, Owner: "owner", State: "published", Revision: "attribution-v1", Output: frozen, Plans: []attributedPrincipalPlan{{OriginalGrantID: "original-a", Grant: PublicEntryGrant{ID: "isolated-a"}}, {OriginalGrantID: "original-b", Grant: PublicEntryGrant{ID: "isolated-b"}}}}
			switch mode {
			case "publication-revision":
				out.Revision = "publication-v99"
			case "swapped":
				out.Attribution.Grants["original-a"] = "isolated-b"
				out.Attribution.Grants["original-b"] = "isolated-a"
			case "duplicate":
				out.Attribution.Grants["original-b"] = "isolated-a"
			case "extra":
				out.Attribution.Grants["extra"] = "isolated-c"
			case "missing":
				delete(out.Attribution.Grants, "original-b")
			case "repeated-profile-id":
				p.PlatformEntryIDs[1] = "original-a"
			case "source":
				p.SourceIDs = []string{"source"}
			case "collection":
				p.CollectionID = "collection"
			case "imported-endpoint":
				p.IR.Endpoints[1].Origin = "imported"
			case "frozen-plan-swap":
				intent.Plans[0].Grant.ID = "isolated-b"
				intent.Plans[1].Grant.ID = "isolated-a"
			case "frozen-plan-duplicate":
				intent.Plans[1] = intent.Plans[0]
			case "other-owner":
				intent.Owner = "other"
			}
			if e := h.s.TenantPut("owner", "output-attribution-intents", out.ID, intent); e != nil {
				t.Fatal(e)
			}
			b := 2 << 20
			snapshot, e := h.s.AttributedPlatformComparisonSnapshot(context.Background(), "owner", time.Now(), &b)
			if e != nil {
				t.Fatal(e)
			}
			want := mode == "normal" || mode == "publication-revision"
			if got := validComparisonAttribution("owner", out, p, snapshot); got != want {
				t.Fatalf("mapping validity=%v want=%v", got, want)
			}
			if want && !smallAttributionShape(out, p) {
				t.Fatal("valid projected platform endpoints rejected")
			}
		})
	}
}
