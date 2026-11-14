package store

import "time"

// admissionCoverage is receipt evidence, not a claim of account/day completeness.
// Only budgets issued by this version get evidence. Legacy records stay unknown.
// It shares the encrypted budget transaction and creates no independent writes.
type admissionCoverage struct {
	Version         int        `json:"version"`
	StartedAt       time.Time  `json:"startedAt"`
	LastReceiptAt   *time.Time `json:"lastReceiptAt,omitempty"`
	FinalReceivedAt *time.Time `json:"finalReceivedAt,omitempty"`
	FinalSource     string     `json:"finalSource,omitempty"`
	ClockUncertain  bool       `json:"clockUncertain,omitempty"`
}

func (b *admissionBudget) recordCoverageReceipt(now time.Time, final bool, source string) {
	c := b.Coverage
	if c == nil || c.Version != 1 || b.Closed {
		return
	}
	// Receipt time is not the node's traffic time. Keep clock reversals explicit;
	// never turn a delayed final into proof that traffic occurred on receipt day.
	if now.Before(c.StartedAt) || c.LastReceiptAt != nil && now.Before(*c.LastReceiptAt) {
		c.ClockUncertain = true
	}
	if c.LastReceiptAt == nil || now.After(*c.LastReceiptAt) {
		t := now
		c.LastReceiptAt = &t
	}
	if final {
		t := now
		c.FinalReceivedAt = &t
		c.FinalSource = source
	}
}
