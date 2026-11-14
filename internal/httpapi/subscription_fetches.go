package httpapi

import (
	"log"
	"net/http"
	"routeweaver/internal/store"
	"time"
)

func (h *server) subscriptionFetches(w http.ResponseWriter, r *http.Request) {
	history, err := h.s.SubscriptionFetches(current(r).Account.ID, time.Now().UTC())
	if err != nil {
		fail(w, 503, "Subscription fetch history is temporarily unavailable.")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, history)
}
func (h *server) recordSubscriptionFetch(owner, id, delivery string) {
	if err := h.s.RecordSubscriptionFetch(owner, store.SubscriptionFetch{OutputID: id, At: time.Now().UTC(), Delivery: delivery}); err != nil {
		// Diagnostics cannot make a successfully written configuration unavailable.
		// Never log owner IDs, request paths, tokens or error payloads here.
		log.Print("subscription fetch history could not be persisted")
	}
}
