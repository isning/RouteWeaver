package httpapi

import (
	"bytes"
	"errors"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestPrincipalMigrationRateWindow(t *testing.T) {
	now := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	p := principalMigrationRatePlan{DeploymentKey: "d", OwnerKey: "o"}
	consume := func(id string, at time.Time) error {
		writes, err := p.writes(id, at)
		if err != nil {
			return err
		}
		p.Deployment = writes[0].Value.(principalMigrationRateRecord)
		p.Owner = writes[1].Value.(principalMigrationRateRecord)
		return nil
	}
	if err := consume("a", now); err != nil {
		t.Fatal(err)
	}
	if err := consume("a", now); err != nil || len(p.Owner.Events) != 1 {
		t.Fatal("retry consumed capacity", err)
	}
	if err := consume("b", now.Add(59*time.Second)); !errors.Is(err, ErrPrincipalMigrationRateLimited) {
		t.Fatal(err)
	}
	if err := consume("b", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := consume("c", now.Add(2*time.Minute)); !errors.Is(err, ErrPrincipalMigrationRateLimited) {
		t.Fatal(err)
	}
	if err := consume("c", now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := consume("d", now.Add(9*time.Minute)); !errors.Is(err, ErrPrincipalMigrationRateLimited) {
		t.Fatal("clock rollback", err)
	}
}

func TestPrincipalMigrationRateAtomicCAS(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{71}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := &server{s: s}
	now := time.Now().UTC()
	a, err := h.preparePrincipalMigrationRate("owner", "deployment", "a", now)
	if err != nil {
		t.Fatal(err)
	}
	b, err := h.preparePrincipalMigrationRate("other", "deployment", "b", now)
	if err != nil {
		t.Fatal(err)
	}
	aw, _ := a.writes("a", now)
	bw, _ := b.writes("b", now)
	bad := append([]store.RecordCompare{}, a.Compares...)
	bad = append(bad, store.RecordCompare{Kind: "missing", ID: "x", Expected: map[string]string{"value": "must exist"}})
	if err := s.CompareAndPutRecords(bad, aw); err == nil {
		t.Fatal("stale CAS accepted")
	}
	var absent principalMigrationRateRecord
	if err := s.Get(principalMigrationRateKind, a.DeploymentKey, &absent); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("failed transaction consumed rate", err)
	}
	if err := s.CompareAndPutRecords(a.Compares, aw); err != nil {
		t.Fatal(err)
	}
	if err := s.CompareAndPutRecords(b.Compares, bw); err == nil {
		t.Fatal("concurrent reservation overwrote deployment rate")
	}
	if err := s.Get(principalMigrationRateKind, b.OwnerKey, &absent); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("loser consumed owner rate", err)
	}
	if _, err := h.preparePrincipalMigrationRate("other", "deployment", "b", now); !errors.Is(err, ErrPrincipalMigrationRateLimited) {
		t.Fatal(err)
	}
}
