package notifications

import "time"

// Scope describes the facts needed by a service operation. Implementations may
// retain all history while reading only a bounded inbox/outbox page or exact IDs.
// SelectEventIDs runs against the settings/announcement snapshot in the SAME
// writer transaction as change; it must be pure and must not call the repository.
type Scope struct {
	All            bool
	Announcements  bool
	EventIDs       []string
	SelectEventIDs func(State) []string
	ReceiptOwner   string
	PendingAt      *time.Time
	PendingEventID string
	OnlyChannel    string
	Inbox          *Recipient
	InboxAt        time.Time
	History        bool
}

type ScopedRepository interface {
	ReadNotificationsScope(Scope) (State, error)
	UpdateNotificationsScope(Scope, func(*State) error) error
}

func (s *Service) read(scope Scope) (State, error) {
	if repo, ok := s.repo.(ScopedRepository); ok {
		return repo.ReadNotificationsScope(scope)
	}
	return s.repo.ReadNotifications()
}
func (s *Service) update(scope Scope, change func(*State) error) error {
	if repo, ok := s.repo.(ScopedRepository); ok {
		return repo.UpdateNotificationsScope(scope, change)
	}
	return s.repo.UpdateNotifications(change)
}

// Visible is the shared eligibility predicate used while streaming a repository
// inbox page. Persistence never substitutes a less restrictive ownership rule.
func Visible(st State, event Event, r Recipient, now time.Time) bool {
	return visible(st, event, r, now)
}

// Evaluate selectors compute only the current candidates. Historic dedupe facts
// are then loaded by exact ID under the writer reservation before enqueue runs.
func selectNotificationEvents(change func(*State) error) func(State) []string {
	return func(base State) []string {
		candidate := DefaultState()
		candidate.Settings = base.Settings
		candidate.Secrets = base.Secrets
		candidate.Announcements = base.Announcements
		if err := change(&candidate); err != nil {
			return nil
		}
		ids := make([]string, 0, len(candidate.Events))
		for id := range candidate.Events {
			ids = append(ids, id)
		}
		return ids
	}
}
