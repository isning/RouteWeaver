package httpapi

import (
	"context"
	"routeweaver/internal/store"
	"testing"
	"time"
)

// Test-only seam runs the real renderer between two real readonly captures.
func CompareAttributedCaptureForTest(t *testing.T, s *store.Store, owner, id string, beforeSecond func()) map[string]string {
	t.Helper()
	var output Output
	if err := s.TenantGet(owner, "outputs", id, &output); err != nil {
		t.Fatal(err)
	}
	calls := 0
	capture := func(ctx context.Context, owner string, now time.Time, budget *int) (*store.PlatformComparisonSnapshot, error) {
		calls++
		if calls == 2 && beforeSecond != nil {
			beforeSecond()
		}
		return s.AttributedPlatformComparisonSnapshot(ctx, owner, now, budget)
	}
	budget := 2 << 20
	result := (&server{s: s}).compareSmallPlatformDraftUsing(context.Background(), owner, output, &budget, capture)
	if calls != 2 {
		t.Fatalf("did not reach post-render capture: %d", calls)
	}
	return result
}
