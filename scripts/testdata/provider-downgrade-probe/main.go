// Synthetic cross-version probe. Build this same source against the pre-feature
// checkout, then run reject against only fixtures produced by this checkout.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"routeweaver/internal/backup"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"routeweaver/internal/store"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 3 {
		return errors.New("usage: probe generate|reject fixture-directory")
	}
	root := os.Args[2]
	path := filepath.Join(root, "provider.db")
	key := bytes.Repeat([]byte{47}, 32)
	switch os.Args[1] {
	case "generate":
		if err := os.MkdirAll(root, 0700); err != nil {
			return err
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			return errors.New("fixture must not already exist")
		}
		s, err := store.Open(path, key)
		if err != nil {
			return err
		}
		defer s.Close()
		if err = s.Put("hosts", "host", domain.Host{ID: "host", Name: "Synthetic"}); err != nil {
			return err
		}
		if err = s.Put("core-instances", "core", domain.CoreInstance{ID: "core", HostID: "host", AdapterID: "routeweaver/managed-xray"}); err != nil {
			return err
		}
		now := time.Now().UTC()
		cfg := observability.Config{BilledInterfaces: []string{}, Provider: &observability.ProviderConfig{Name: "Synthetic", Mode: "limited", Allowance: 1, Unit: "GB", CycleID: "cycle", CycleStart: now.Add(-time.Hour), CycleEnd: now.Add(time.Hour), NotificationSource: "provider_statement", ExhaustionAction: "suspend-managed"}}
		if _, err = s.ConfigureNodeObservations("host", cfg); err != nil {
			return err
		}
		snapshot, err := s.ExportSnapshot(context.Background())
		if err != nil {
			return err
		}
		if len(snapshot.Migrations) != 3 {
			return errors.New("fixture is not fenced")
		}
		raw, err := json.Marshal(snapshot)
		if err != nil {
			return err
		}
		if err = os.WriteFile(filepath.Join(root, "snapshot.json"), raw, 0600); err != nil {
			return err
		}
		var archive bytes.Buffer
		if err = backup.CreateStream(context.Background(), s, "synthetic-provider-downgrade-passphrase", &archive, backup.DefaultLimits()); err != nil {
			return err
		}
		preview, err := backup.PreviewStream(context.Background(), bytes.NewReader(archive.Bytes()), "synthetic-provider-downgrade-passphrase", backup.DefaultLimits())
		if err != nil {
			return err
		}
		preview.Close()
		if err = os.WriteFile(filepath.Join(root, "backup.rwb"), archive.Bytes(), 0600); err != nil {
			return err
		}
		fmt.Println("generated synthetic fenced database, logical snapshot and verified encrypted stream backup")
	case "reject":
		raw, err := os.ReadFile(filepath.Join(root, "snapshot.json"))
		if err != nil {
			return err
		}
		var snapshot store.Snapshot
		if err = json.Unmarshal(raw, &snapshot); err != nil {
			return err
		}
		if store.ValidateSnapshot(snapshot) == nil {
			return errors.New("old snapshot validator accepted enforcing feature")
		}
		databaseBefore, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		s, err := store.Open(path, key)
		if err == nil {
			s.Close()
			return errors.New("old store opened enforcing feature")
		}
		if !errors.Is(err, store.ErrUnsupportedSchema) {
			return fmt.Errorf("unexpected old-reader rejection: %w", err)
		}
		databaseAfter, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !bytes.Equal(databaseBefore, databaseAfter) {
			return errors.New("old rejected reader mutated database bytes")
		}
		archive, err := os.ReadFile(filepath.Join(root, "backup.rwb"))
		if err != nil {
			return err
		}
		preview, err := backup.PreviewStream(context.Background(), bytes.NewReader(archive), "synthetic-provider-downgrade-passphrase", backup.DefaultLimits())
		if err == nil {
			preview.Close()
			return errors.New("old streaming backup reader accepted enforcing feature")
		}
		if !errors.Is(err, backup.ErrInvalid) && !errors.Is(err, backup.ErrUnsupported) {
			return fmt.Errorf("unexpected streaming backup rejection: %w", err)
		}
		fmt.Println("PASS: pre-feature snapshot validator, encrypted streaming backup reader and physical Store.Open reject migration3")
	default:
		return errors.New("unknown probe mode")
	}
	return nil
}
