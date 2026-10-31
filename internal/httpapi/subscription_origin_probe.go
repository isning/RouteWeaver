package httpapi

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"net/http"
	"net/url"
	"routeweaver/internal/auth"
	"routeweaver/internal/resources"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

type subscriptionChallenge struct {
	authority string
	answer    string
	expires   time.Time
}

// A challenge is transient and usable only for its intended authority. The
// expected random answer is not sent to the destination and contains no account,
// feed credential, or persistent instance secret.
type subscriptionVerification struct {
	client     *http.Client
	now        func() time.Time
	mu         sync.Mutex
	challenges map[string]subscriptionChallenge
}

func newSubscriptionVerification() *subscriptionVerification {
	return &subscriptionVerification{client: resources.OutboundClient(10 * time.Second), now: time.Now, challenges: map[string]subscriptionChallenge{}}
}
func (v *subscriptionVerification) verify(ctx context.Context, origin string) error {
	canonical, err := canonicalSubscriptionOrigin(origin)
	if err != nil || canonical == "" || canonical != origin {
		return errors.New("invalid subscription origin")
	}
	nonce, err := auth.Token()
	if err != nil {
		return err
	}
	answer, err := auth.Token()
	if err != nil {
		return err
	}
	u, _ := url.Parse(origin)
	v.mu.Lock()
	if len(v.challenges) >= 4 {
		v.mu.Unlock()
		return errors.New("verification busy")
	}
	v.challenges[nonce] = subscriptionChallenge{authority: u.Host, answer: answer, expires: v.now().Add(15 * time.Second)}
	v.mu.Unlock()
	defer func() { v.mu.Lock(); delete(v.challenges, nonce); v.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/feed/verify/"+nonce, nil)
	if err != nil {
		return err
	}
	response, err := v.client.Do(request)
	if err != nil {
		return errors.New("subscription origin verification failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("subscription origin verification failed")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 128))
	if err != nil || subtle.ConstantTimeCompare(body, []byte(answer)) != 1 {
		return errors.New("subscription origin did not reach this instance")
	}
	return nil
}
func (v *subscriptionVerification) serveChallenge(w http.ResponseWriter, r *http.Request) {
	nonce := chi.URLParam(r, "challenge")
	if len(nonce) != 43 {
		fail(w, 404, "not found")
		return
	}
	authority, err := CanonicalPublicOrigin("https://" + r.Host)
	v.mu.Lock()
	challenge, found := v.challenges[nonce]
	v.mu.Unlock()
	if err != nil || !found || authority != "https://"+challenge.authority || !v.now().Before(challenge.expires) {
		fail(w, 404, "not found")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, challenge.answer)
}
