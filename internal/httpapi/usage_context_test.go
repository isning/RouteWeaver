package httpapi

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestOverviewContextStopsCancelledHistoricalRead(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// No Store is needed: cancellation must stop before any work or history scan.
	h := &server{}
	_, err := h.overviewContext(ctx, "synthetic", time.Now())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled overview: %v", err)
	}
}
