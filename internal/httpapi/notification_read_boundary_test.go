package httpapi_test

import (
	"encoding/json"
	"routeweaver/internal/notifications"
	"strings"
	"testing"
	"time"
)

func TestPersonalInboxDoesNotEvaluateGlobalUsageHistory(t *testing.T) {
	s, srv := makeServer(t)
	owner := inviteClient(t, s, srv, "inbox-history-boundary")
	now := time.Now().UTC()
	if err := s.UpdateNotifications(func(st *notifications.State) error {
		st.Events["existing"] = notifications.Event{EventID: "existing", RecipientID: owner.id, Title: "Existing personal notice", CreatedAt: now}
		st.Deliveries["existing/in-app"] = notifications.Delivery{EventID: "existing", Channel: "in-app", Status: "available", CreatedAt: now}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// A synthetic corrupt record outside the inbox must not be read/reduced by
	// this personal read. The background evaluator can report it independently.
	if err := s.Put("ledger", "unrelated-poison", json.RawMessage(`{"userId":99}`)); err != nil {
		t.Fatal(err)
	}
	code, _, body := req(t, owner.c, "GET", srv.URL+"/api/me/notifications", "", nil)
	if code != 200 || !strings.Contains(body, "Existing personal notice") {
		t.Fatalf("inbox depended on unrelated global ledger: %d %s", code, body)
	}
}
