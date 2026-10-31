// Package notifications owns announcement eligibility, notification deduplication,
// and a bounded at-least-once outbox. Persistence is supplied by a repository;
// secure external delivery is an adapter in this same control-plane module.
package notifications

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"routeweaver/internal/domain"
	"routeweaver/internal/resources"
	"sort"
	"strings"
	"time"
)

var ErrNotFound = errors.New("notification not found")
var ErrConflict = errors.New("notification settings changed; reload before saving")

const MaxAttempts = 5

type EmailSettings struct {
	Enabled   bool     `json:"enabled"`
	Automatic bool     `json:"automatic"`
	Host      string   `json:"host"`
	Port      int      `json:"port"`
	TLSMode   string   `json:"tlsMode"`
	Username  string   `json:"username"`
	From      string   `json:"from"`
	To        []string `json:"to"`
}
type WebhookSettings struct {
	Enabled   bool   `json:"enabled"`
	Automatic bool   `json:"automatic"`
	URL       string `json:"url"`
}
type Settings struct {
	Revision                 uint64          `json:"revision"`
	InApp                    bool            `json:"inApp"`
	QuotaPercent             []int           `json:"quotaPercent"`
	ExpiryHours              []int           `json:"expiryHours"`
	ProviderRemainingPercent []int           `json:"providerRemainingPercent"`
	RepeatHours              int             `json:"repeatHours"`
	Email                    EmailSettings   `json:"email"`
	Webhook                  WebhookSettings `json:"webhook"`
}
type SettingsView struct {
	Settings
	SMTPPasswordSet  bool `json:"smtpPasswordSet"`
	WebhookSecretSet bool `json:"webhookSecretSet"`
}
type SettingsInput struct {
	Settings
	SMTPPassword  *string `json:"smtpPassword,omitempty"`
	WebhookSecret *string `json:"webhookSecret,omitempty"`
	// These presence flags are accepted from a GET/edit round trip but never
	// trusted as evidence that a secret exists.
	SMTPPasswordSet  bool `json:"smtpPasswordSet,omitempty"`
	WebhookSecretSet bool `json:"webhookSecretSet,omitempty"`
}

// Secrets never appears in a public API response. Repository data is encrypted.
type Secrets struct {
	SMTPPassword  string
	WebhookSecret string
}
type Announcement struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Audience  string    `json:"audience"`
	UserIDs   []string  `json:"userIds"`
	StartsAt  time.Time `json:"startsAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	Enabled   bool      `json:"enabled"`
}
type Recipient struct {
	ID      string
	Role    string
	Enabled bool
}
type UserSnapshot struct {
	UserID     string
	Enabled    bool
	QuotaBytes int64
	UsedBytes  int64
	CycleID    string
	ExpiresAt  *time.Time
}

// ProviderSnapshot is observed operator-managed inventory, not inferred from a
// user traffic counter. CycleID identifies the provider accounting/reset period.
type ProviderSnapshot struct {
	// Source labels a NIC estimate separately from an operator-entered provider statement.
	Source         string
	ID             string
	Name           string
	CycleID        string
	RemainingBytes int64
	TotalBytes     int64
	ExpiresAt      *time.Time
	ObservedAt     time.Time
}
type Event struct {
	EventID        string     `json:"eventId"`
	Kind           string     `json:"kind"`
	RecipientID    string     `json:"recipientId"`
	Title          string     `json:"title"`
	Body           string     `json:"body"`
	CreatedAt      time.Time  `json:"createdAt"`
	ExpiresAt      *time.Time `json:"expiresAt,omitempty"`
	AnnouncementID string     `json:"announcementId,omitempty"`
	AdminOnly      bool       `json:"adminOnly,omitempty"`
}
type InboxItem struct {
	Event
	ReadAt *time.Time `json:"readAt,omitempty"`
}
type Delivery struct {
	EventID          string    `json:"eventId"`
	Channel          string    `json:"channel"`
	Status           string    `json:"status"`
	Attempts         int       `json:"attempts"`
	NextAttemptAt    time.Time `json:"nextAttemptAt"`
	LastError        string    `json:"lastError,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
	LeaseUntil       time.Time `json:"leaseUntil"`
	LeaseToken       string    `json:"leaseToken"`
	SettingsRevision uint64    `json:"settingsRevision"`
	Explicit         bool      `json:"explicit"`
}
type OutboxItem struct {
	EventID       string    `json:"eventId"`
	Channel       string    `json:"channel"`
	Status        string    `json:"status"`
	Attempts      int       `json:"attempts"`
	NextAttemptAt time.Time `json:"nextAttemptAt"`
	LastError     string    `json:"lastError,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	Kind          string    `json:"kind"`
	Title         string    `json:"title"`
}

// State is a private repository snapshot. Do not serve it through an API.
type State struct {
	Settings      Settings
	Secrets       Secrets
	Announcements map[string]Announcement
	Events        map[string]Event
	Deliveries    map[string]Delivery
	Reads         map[string]time.Time
}

func DefaultState() State {
	return State{Settings: Settings{InApp: true, QuotaPercent: []int{80, 100}, ExpiryHours: []int{72, 24}, ProviderRemainingPercent: []int{10}, RepeatHours: 24, Email: EmailSettings{Port: 587, TLSMode: "starttls", To: []string{}}}, Announcements: map[string]Announcement{}, Events: map[string]Event{}, Deliveries: map[string]Delivery{}, Reads: map[string]time.Time{}}
}
func (s *State) Normalize() {
	if s.Announcements == nil {
		s.Announcements = map[string]Announcement{}
	}
	if s.Events == nil {
		s.Events = map[string]Event{}
	}
	if s.Deliveries == nil {
		s.Deliveries = map[string]Delivery{}
	}
	if s.Reads == nil {
		s.Reads = map[string]time.Time{}
	}
}

type Repository interface {
	ReadNotifications() (State, error)
	UpdateNotifications(func(*State) error) error
}
type Transport interface {
	Send(context.Context, string, Event, Settings, Secrets) error
}
type Service struct {
	repo      Repository
	transport Transport
}

func New(repo Repository, transport Transport) *Service {
	if transport == nil {
		transport = NewSecureTransport()
	}
	return &Service{repo: repo, transport: transport}
}
func key(parts ...any) string {
	b, _ := json.Marshal(parts)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func deliveryKey(event, channel string) string { return event + "/" + channel }
func validText(s string, max int) bool {
	return strings.TrimSpace(s) != "" && len(s) <= max && !strings.ContainsRune(s, 0)
}
func validEmail(s string) bool {
	a, e := mail.ParseAddress(s)
	return e == nil && a.Address == s && !strings.ContainsAny(s, "\r\n")
}
func validateSettings(s Settings, secret Secrets) error {
	if s.RepeatHours < 1 || s.RepeatHours > 24*30 {
		return fmt.Errorf("repeatHours must be 1–720")
	}
	for _, v := range []struct {
		values []int
		max    int
		name   string
	}{{s.QuotaPercent, 100, "quotaPercent"}, {s.ExpiryHours, 24 * 366, "expiryHours"}, {s.ProviderRemainingPercent, 100, "providerRemainingPercent"}} {
		if len(v.values) > 10 {
			return fmt.Errorf("%s allows at most ten thresholds", v.name)
		}
		seen := map[int]bool{}
		for _, n := range v.values {
			if n < 1 || n > v.max || seen[n] {
				return fmt.Errorf("%s contains an invalid or duplicate threshold", v.name)
			}
			seen[n] = true
		}
	}
	e := s.Email
	if e.Automatic && !e.Enabled || s.Webhook.Automatic && !s.Webhook.Enabled {
		return fmt.Errorf("automatic delivery requires the channel to be enabled")
	}
	if e.Host != "" {
		if err := resources.PublicHostname(e.Host); err != nil {
			return fmt.Errorf("SMTP host must be a public hostname")
		}
	}
	if e.Port < 1 || e.Port > 65535 || (e.TLSMode != "starttls" && e.TLSMode != "tls") {
		return fmt.Errorf("SMTP requires valid port and verified tls or starttls")
	}
	if len(e.Username) > 320 || strings.ContainsAny(e.Username, "\x00\r\n") || len(secret.SMTPPassword) > 4096 {
		return fmt.Errorf("invalid SMTP authentication settings")
	}
	if e.From != "" && !validEmail(e.From) {
		return fmt.Errorf("invalid sender address")
	}
	if len(e.To) > 10 {
		return fmt.Errorf("at most ten explicit email recipients are allowed")
	}
	seen := map[string]bool{}
	for _, a := range e.To {
		if !validEmail(a) || seen[a] {
			return fmt.Errorf("invalid or duplicate email recipient")
		}
		seen[a] = true
	}
	if e.Enabled && (e.Host == "" || e.From == "" || len(e.To) == 0 || (e.Username != "" && secret.SMTPPassword == "")) {
		return fmt.Errorf("enabled email requires SMTP host, sender, recipients and authentication secret when a username is set")
	}
	if s.Webhook.URL != "" {
		if err := resources.ValidateHTTPSURL(s.Webhook.URL); err != nil {
			return fmt.Errorf("webhook requires a public HTTPS URL without query, fragment or credentials")
		}
	}
	if s.Webhook.Enabled && (s.Webhook.URL == "" || len(secret.WebhookSecret) < 32) {
		return fmt.Errorf("enabled webhook requires a destination and signing secret of at least 32 bytes")
	}
	if len(secret.WebhookSecret) > 4096 {
		return fmt.Errorf("webhook signing secret is too long")
	}
	return nil
}
func validateAnnouncement(a Announcement) error {
	if !domain.ValidID(a.ID) || !validText(a.Title, 160) || !validText(a.Body, 8000) {
		return fmt.Errorf("valid id, title (160 bytes) and body (8000 bytes) required")
	}
	if a.StartsAt.IsZero() || a.ExpiresAt.IsZero() || !a.ExpiresAt.After(a.StartsAt) || a.ExpiresAt.Sub(a.StartsAt) > 366*24*time.Hour {
		return fmt.Errorf("announcement requires a validity window of at most 366 days")
	}
	if a.Audience != "all" && a.Audience != "admins" && a.Audience != "users" {
		return fmt.Errorf("audience must be all, admins or selected users")
	}
	if a.Audience == "users" && (len(a.UserIDs) == 0 || len(a.UserIDs) > 500) {
		return fmt.Errorf("selected audience requires 1–500 user IDs")
	}
	if a.Audience != "users" && len(a.UserIDs) > 0 {
		return fmt.Errorf("user IDs are only valid for a selected users audience")
	}
	seen := map[string]bool{}
	for _, id := range a.UserIDs {
		if !domain.ValidID(id) || seen[id] {
			return fmt.Errorf("invalid or duplicate audience user")
		}
		seen[id] = true
	}
	return nil
}
func eligible(a Announcement, r Recipient, now time.Time) bool {
	if !r.Enabled || !a.Enabled || now.Before(a.StartsAt) || !now.Before(a.ExpiresAt) {
		return false
	}
	if a.Audience == "all" || a.Audience == "admins" && r.Role == "admin" {
		return true
	}
	if a.Audience == "users" {
		for _, id := range a.UserIDs {
			if id == r.ID {
				return true
			}
		}
	}
	return false
}
func sortedEvents(items []InboxItem) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].EventID < items[j].EventID
		}
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
}
