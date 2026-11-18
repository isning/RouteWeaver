package controlprotocol

import (
	"routeweaver/internal/domain"
	"time"
)

// HostAssignment carries a private instance credential over authenticated TLS.
// It is never a public inventory representation or evidence of core application.
type HostAssignment struct {
	Instance domain.CoreInstance `json:"instance"`
	Scope    Scope               `json:"scope"`
	Token    string              `json:"token"`
}
type HostAssignments struct {
	NodeID          string           `json:"nodeId"`
	EnrollmentEpoch string           `json:"enrollmentEpoch"`
	ExpiresAt       time.Time        `json:"expiresAt"`
	Instances       []HostAssignment `json:"instances"`
}

const MaxHostInstances = 64
