package observability

import "time"

// ManagedAdmission is an explicit opt-in guard for short managed connection
// leases, not provider billing reconciliation or stock-core enforcement. Unknown
// selected evidence fails closed; advisory remains entirely non-enforcing.
func ManagedAdmission(s State, now time.Time) (string, *time.Time) {
	c := s.Config.Provider
	if c == nil || c.ExhaustionAction == "advisory" {
		return "", nil
	}
	if ValidateConfig(s.Config) != nil {
		return "provider-usage-unknown", nil
	}
	if c.ExpiresAt != nil && !now.Before(*c.ExpiresAt) {
		return "provider-expired", nil
	}
	return managedAdmissionView(c, ViewOf("", s, now).Provider, now)
}
func managedAdmissionView(c *ProviderConfig, p ProviderView, now time.Time) (string, *time.Time) {
	if c == nil || c.ExhaustionAction == "advisory" {
		return "", nil
	}
	if c.ExpiresAt != nil && !now.Before(*c.ExpiresAt) {
		return "provider-expired", nil
	}
	if !p.NotificationEligible || p.RemainingBytes == nil || p.ObservedAt == nil {
		return "provider-usage-unknown", nil
	}
	if *p.RemainingBytes == 0 {
		return "provider-exhausted", nil
	}
	until := p.ObservedAt.Add(FreshFor)
	if c.CycleEnd.Before(until) {
		until = c.CycleEnd
	}
	if c.ExpiresAt != nil && c.ExpiresAt.Before(until) {
		until = *c.ExpiresAt
	}
	if !now.Before(until) {
		return "provider-usage-unknown", nil
	}
	return "", &until
}
