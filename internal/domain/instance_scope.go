package domain

// InstanceScope identifies one enrolled core instance on a physical node.
// EnrollmentEpoch fences superseded agents. It is a pure identity value shared
// by observation, diagnostics and transport, not proof of authentication.
type InstanceScope struct {
	NodeID          string `json:"nodeId"`
	InstanceID      string `json:"instanceId"`
	EnrollmentEpoch string `json:"enrollmentEpoch"`
}
