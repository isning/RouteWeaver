package store_test

import (
	"context"
	"routeweaver/internal/store"
	"testing"
)

func TestProviderSuspensionCapacityInventoryAcceptsSemanticFence(t *testing.T) {
	s, _, now, _, _ := providerRouteFixture(t)
	limits := store.BackupLimits{MaxRows: 2000000, MaxBytes: 1 << 30, MaxRecordBytes: 32 << 20}
	before, err := s.HistoryCapacityInventory(context.Background(), limits)
	if err != nil {
		t.Fatal(err)
	}
	state, err := s.ConfigureNodeObservations("transit-node", suspensionConfig(now))
	if err != nil {
		t.Fatal(err)
	}
	enabled, err := s.HistoryCapacityInventory(context.Background(), limits)
	if err != nil {
		t.Fatalf("valid provider semantic migration rejected by capacity inspector: %v", err)
	}
	// Exactly one provider record and one semantic migration were added.
	if enabled.BackupRows.Count != before.BackupRows.Count+2 || enabled.BackupRows.AtLeast || enabled.ArchiveBytes != nil {
		t.Fatalf("incorrect bounded capacity result after enabling policy: before=%+v after=%+v", before, enabled)
	}
	state.Config.Provider.ExhaustionAction = "advisory"
	if _, err = s.ConfigureNodeObservations("transit-node", state.Config); err != nil {
		t.Fatal(err)
	}
	disabled, err := s.HistoryCapacityInventory(context.Background(), limits)
	if err != nil || disabled.BackupRows.Count != enabled.BackupRows.Count {
		t.Fatal("monotonic fence no longer inspectable", disabled, err)
	}
}
