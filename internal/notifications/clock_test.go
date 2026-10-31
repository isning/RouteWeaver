package notifications

import (
	"context"
	"time"
)

// DispatchWithClockForTest exposes only the time seam to external behavior tests;
// the production service interface does not acquire a test-only clock option.
func DispatchWithClockForTest(s *Service, ctx context.Context, recipients []Recipient, clock func() time.Time) error {
	return s.dispatchWithClock(ctx, recipients, clock, "", "")
}
