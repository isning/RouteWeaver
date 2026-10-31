package controlprotocol

import "time"

// ServiceHeartbeat carries a freshly observed runtime fact, not an inference from
// a missing cached observation. Only an explicitly continuous driver sends it.
// It grants no authority: the control plane must require persisted admin opt-in.
type ServiceHeartbeat struct {
	Desired        Identity    `json:"desired"`
	Observed       Observation `json:"observed"`
	PolicyIssuedAt time.Time   `json:"policyIssuedAt"`
	ServiceActive  bool        `json:"serviceActive"`
}

// PolicyRefresh extends authorization for this exact already-active identity.
// It is separate from immutable Desired and cannot activate a runtime.
type PolicyRefresh struct {
	Identity Identity    `json:"identity"`
	IntentID string      `json:"intentId"`
	Sequence uint64      `json:"sequence,string"`
	Lease    PolicyLease `json:"policyLease"`
}
type ServiceHeartbeatResult struct {
	PolicyRefresh *PolicyRefresh `json:"policyRefresh,omitempty"`
}
