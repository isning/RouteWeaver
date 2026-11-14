package httpapi

import (
	"errors"
	"fmt"
	"routeweaver/internal/auth"
	"routeweaver/internal/store"
	"time"
)

var ErrPrincipalMigrationRateLimited = errors.New("principal migration waiting for rate limit")

const principalMigrationRateKind = "principal-migration-rate-limits"

type principalMigrationRateEvent struct {
	MigrationID string    `json:"migrationId"`
	At          time.Time `json:"at"`
}
type principalMigrationRateRecord struct {
	Events []principalMigrationRateEvent `json:"events"`
}
type principalMigrationRatePlan struct {
	Compares      []store.RecordCompare
	Deployment    principalMigrationRateRecord
	Owner         principalMigrationRateRecord
	DeploymentKey string
	OwnerKey      string
}

// Separate from fleet authority inputs: rate accounting is not runtime authority.
func (h *server) preparePrincipalMigrationRate(owner, deployment, migration string, now time.Time) (principalMigrationRatePlan, error) {
	p := principalMigrationRatePlan{DeploymentKey: "deployment-" + deployment, OwnerKey: "owner-" + auth.Digest(owner+"\x00"+deployment)}
	proof := preparedFleet{}
	if err := h.fleetRead(&proof, principalMigrationRateKind, p.DeploymentKey, &p.Deployment, true); err != nil {
		return p, err
	}
	if err := h.fleetRead(&proof, principalMigrationRateKind, p.OwnerKey, &p.Owner, true); err != nil {
		return p, err
	}
	p.Compares = proof.Compares
	_, err := p.writes(migration, now)
	return p, err
}

func advancePrincipalMigrationRate(r principalMigrationRateRecord, migration string, now time.Time, window time.Duration, limit int) (principalMigrationRateRecord, error) {
	next := principalMigrationRateRecord{}
	// Preserve bounded history; clock rollback fails closed until timestamps catch up.
	if len(r.Events) > limit {
		return next, fmt.Errorf("invalid principal migration rate record")
	}
	for _, e := range r.Events {
		if e.MigrationID == "" || e.At.IsZero() {
			return next, fmt.Errorf("invalid principal migration rate event")
		}
		if e.At.After(now) {
			return next, ErrPrincipalMigrationRateLimited
		}
		if now.Sub(e.At) < window {
			next.Events = append(next.Events, e)
		}
	}
	for _, e := range next.Events {
		if e.MigrationID == migration {
			return next, nil
		}
	}
	if len(next.Events) >= limit {
		return next, ErrPrincipalMigrationRateLimited
	}
	next.Events = append(next.Events, principalMigrationRateEvent{MigrationID: migration, At: now})
	return next, nil
}
func (p principalMigrationRatePlan) writes(migration string, now time.Time) ([]store.RecordWrite, error) {
	deployment, err := advancePrincipalMigrationRate(p.Deployment, migration, now, time.Minute, 1)
	if err != nil {
		return nil, err
	}
	owner, err := advancePrincipalMigrationRate(p.Owner, migration, now, 10*time.Minute, 2)
	if err != nil {
		return nil, err
	}
	return []store.RecordWrite{{Kind: principalMigrationRateKind, ID: p.DeploymentKey, Value: deployment}, {Kind: principalMigrationRateKind, ID: p.OwnerKey, Value: owner}}, nil
}
