package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// LocalFixture is deliberately named and labeled as an on-disk simulation. It
// never starts a proxy, touches a VPS, binds a port, or proves network behavior.
type LocalFixture struct{}

func (LocalFixture) Descriptor() Descriptor {
	return Descriptor{ID: LocalFixtureID, Version: "1", CanActivate: true, Evidence: "local_fixture_only"}
}
func (LocalFixture) Validate(ctx context.Context, s Staged) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	b, err := os.ReadFile(filepath.Join(s.Directory, filepath.FromSlash(s.Desired.EntryFile)))
	if err != nil {
		return err
	}
	if !json.Valid(b) {
		return errors.New("invalid fixture JSON")
	}
	return nil
}
func (LocalFixture) Activate(ctx context.Context, s Staged) error {
	if err := ctx.Err(); err != nil {
		return &NotAppliedError{Code: "cancelled_before_fixture_activation"}
	}
	obs := Observation{Identity: s.Desired.Identity(), Known: true, Quiescent: true, Evidence: "local_fixture_only", ObservedAt: time.Now().UTC()}
	return writeJSON(filepath.Join(s.Root, "fixture-observation.json"), obs)
}
func (LocalFixture) Observe(ctx context.Context, root string) (Observation, error) {
	if err := ctx.Err(); err != nil {
		return Observation{}, err
	}
	var obs Observation
	err := readJSON(filepath.Join(root, "fixture-observation.json"), &obs)
	if errors.Is(err, os.ErrNotExist) {
		return Observation{Known: true, Quiescent: true, Evidence: "local_fixture_only", ObservedAt: time.Now().UTC()}, nil
	}
	if err == nil {
		obs.ObservedAt = time.Now().UTC()
	}
	return obs, err
}

func (LocalFixture) Restrict(ctx context.Context, root string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(root, "fixture-observation.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(root)
}
