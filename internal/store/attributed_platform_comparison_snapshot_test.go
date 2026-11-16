package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestAttributedPlatformSnapshotCapturesOnlyOwnerIntentAndExtraEvidence(t *testing.T) {
	s, now := platformSnapshotFixture(t)
	put := func(kind, id string, v any) {
		t.Helper()
		if e := s.Put(kind, id, v); e != nil {
			t.Fatal(e)
		}
	}
	extra := []string{"entry-admission-bindings", "output-attribution-claims", "core-instances", "node-observability", TenantKind("owner", "output-attribution-intents")}
	for _, kind := range extra {
		put(kind, "evidence", map[string]string{"value": "v1"})
	}
	put(TenantKind("other", "output-attribution-intents"), "secret", map[string]string{"value": "other"})
	b := 2 << 20
	p, e := s.AttributedPlatformComparisonSnapshot(context.Background(), "owner", now, &b)
	if e != nil {
		t.Fatal(e)
	}
	if b >= 2<<20 {
		t.Fatal("not charged")
	}
	ordinary := capturePlatform(t, s, now)
	for _, kind := range extra {
		var v map[string]string
		if e = p.Get(kind, "evidence", &v); e != nil || v["value"] != "v1" {
			t.Fatal(kind, e)
		}
		if e = ordinary.Get(kind, "evidence", &v); !errors.Is(e, ErrPlatformComparisonUnavailable) {
			t.Fatal("ordinary captured attribution", kind, e)
		}
	}
	var value any
	if e = p.TenantGet("other", "output-attribution-intents", "secret", &value); !errors.Is(e, ErrPlatformComparisonUnavailable) {
		t.Fatal("cross-owner read", e)
	}
	if _, e = p.List(TenantKind("other", "output-attribution-intents")); !errors.Is(e, ErrPlatformComparisonUnavailable) {
		t.Fatal("cross-owner list", e)
	}
	for _, kind := range extra {
		before := p.Fingerprint()
		put(kind, "evidence", map[string]string{"value": "v2"})
		b = 2 << 20
		p, e = s.AttributedPlatformComparisonSnapshot(context.Background(), "owner", now, &b)
		if e != nil || p.Fingerprint() == before {
			t.Fatal("value not fenced", kind, e)
		}
		before = p.Fingerprint()
		put(kind, "new", map[string]string{"value": "new"})
		b = 2 << 20
		p, e = s.AttributedPlatformComparisonSnapshot(context.Background(), "owner", now, &b)
		if e != nil || p.Fingerprint() == before {
			t.Fatal("membership not fenced", kind, e)
		}
	}
	if capturePlatform(t, s, now).Fingerprint() != ordinary.Fingerprint() {
		t.Fatal("extra changes affect ordinary fingerprint")
	}
}

func TestAttributedPlatformSnapshotExtraGrowthDoesNotAffectOrdinary(t *testing.T) {
	for _, kind := range []string{"entry-admission-bindings", "output-attribution-claims", "core-instances", "node-observability", TenantKind("owner", "output-attribution-intents")} {
		t.Run(kind, func(t *testing.T) {
			s, now := platformSnapshotFixture(t)
			before := capturePlatform(t, s, now)
			for i := 0; i < 65; i++ {
				if e := s.Put(kind, fmt.Sprintf("extra-%d", i), map[string]string{"value": "x"}); e != nil {
					t.Fatal(e)
				}
			}
			b := 2 << 20
			if _, e := s.AttributedPlatformComparisonSnapshot(context.Background(), "owner", now, &b); !errors.Is(e, ErrPlatformComparisonUnavailable) {
				t.Fatal("truncated collection accepted", e)
			}
			after := capturePlatform(t, s, now)
			if after.Fingerprint() != before.Fingerprint() {
				t.Fatal("ordinary changed")
			}
		})
	}
}
func TestAttributedPlatformSnapshotByteAndSharedBudgets(t *testing.T) {
	for _, mode := range []string{"record", "shared", "other-owner"} {
		t.Run(mode, func(t *testing.T) {
			s, now := platformSnapshotFixture(t)
			b := 2 << 20
			if mode == "record" {
				if e := s.Put("output-attribution-claims", "huge", strings.Repeat("x", 65536)); e != nil {
					t.Fatal(e)
				}
			}
			if mode == "shared" {
				b = 20
			}
			if mode == "other-owner" {
				for i := 0; i < 70; i++ {
					if e := s.TenantPut("other", "output-attribution-intents", fmt.Sprint(i), strings.Repeat("x", 65536)); e != nil {
						t.Fatal(e)
					}
				}
			}
			_, e := s.AttributedPlatformComparisonSnapshot(context.Background(), "owner", now, &b)
			if mode == "other-owner" {
				if e != nil {
					t.Fatal("other tenant widens read scope", e)
				}
			} else if !errors.Is(e, ErrPlatformComparisonUnavailable) {
				t.Fatal(e)
			}
			capturePlatform(t, s, now)
		})
	}
}

func TestAttributedPlatformSnapshotTwoCapturesShareOneBudget(t *testing.T) {
	s, now := platformSnapshotFixture(t)
	b := 2 << 20
	if _, e := s.AttributedPlatformComparisonSnapshot(context.Background(), "owner", now, &b); e != nil {
		t.Fatal(e)
	}
	used := (2 << 20) - b
	b = used*2 - 1
	if _, e := s.AttributedPlatformComparisonSnapshot(context.Background(), "owner", now, &b); e != nil {
		t.Fatal("first capture", e)
	}
	if _, e := s.AttributedPlatformComparisonSnapshot(context.Background(), "owner", now, &b); !errors.Is(e, ErrPlatformComparisonUnavailable) {
		t.Fatal("second capture reset shared budget", e)
	}
	if b < 0 {
		t.Fatal("budget overshot")
	}
}
