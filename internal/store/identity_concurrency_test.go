package store_test

import (
	"bytes"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
	"routeweaver/internal/store"
)

func identityHandles(t *testing.T) (*store.Store, *store.Store, *store.Store) {
	t.Helper()
	path, key := filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{73}, 32)
	open := func() *store.Store {
		s, err := store.Open(path, key)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { s.Close() })
		return s
	}
	return open(), open(), open()
}

func holdIdentityWriter(t *testing.T, writer *store.Store) func() {
	t.Helper()
	locked, release := make(chan struct{}), make(chan struct{})
	writeResult := make(chan error, 1)
	go func() {
		_, err := writer.GenerateRecord("contention-fixture", "write", func(uint64) (any, error) {
			close(locked)
			<-release
			return map[string]bool{"done": true}, nil
		})
		writeResult <- err
	}()
	select {
	case <-locked:
	case err := <-writeResult:
		t.Fatalf("cannot hold fixture writer: %v", err)
	}
	var once sync.Once
	unlock := func() {
		once.Do(func() {
			close(release)
			if err := <-writeResult; err != nil {
				t.Errorf("fixture writer failed: %v", err)
			}
		})
	}
	t.Cleanup(unlock)
	return unlock
}

func TestTOTPStepIsSingleUseAcrossStoreHandles(t *testing.T) {
	for _, operation := range []string{"authenticate", "login"} {
		t.Run(operation, func(t *testing.T) {
			first, second, _ := identityHandles(t)
			const password = "synthetic-concurrent-password"
			if err := first.EnsureAdmin("operator", password); err != nil {
				t.Fatal(err)
			}
			now := time.Unix(1800000000, 0)
			secret, _, err := first.BeginMFA("admin", password, now)
			if err != nil {
				t.Fatal(err)
			}
			code, err := totp.GenerateCode(secret, now)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, _, err = first.EnableMFA("admin", code, now); err != nil {
				t.Fatal(err)
			}
			now = now.Add(30 * time.Second)
			code, err = totp.GenerateCode(secret, now)
			if err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			for _, s := range []*store.Store{first, second} {
				go func(s *store.Store) {
					<-start
					var err error
					if operation == "login" {
						_, _, _, err = s.Login("operator", password, code, now)
					} else {
						_, err = s.Authenticate("operator", password, code, now)
					}
					results <- err
				}(s)
			}
			close(start)
			accepted := 0
			for range 2 {
				if <-results == nil {
					accepted++
				}
			}
			if accepted != 1 {
				t.Fatalf("one TOTP step authorized %d concurrent %s requests; want exactly one", accepted, operation)
			}
		})
	}
}

func TestInvitationIsSingleUseAcrossContendingStoreHandles(t *testing.T) {
	first, second, writer := identityHandles(t)
	_, token, err := first.CreateInvite("Invited user", "user", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	// Hold a real SQLite writer from a third handle while both callers validate
	// the invitation. This models contention from an unrelated durable mutation;
	// correctness must not depend on one Store handle's in-process mutex.
	unlock := holdIdentityWriter(t, writer)
	start := make(chan struct{})
	results := make(chan error, 2)
	for i, s := range []*store.Store{first, second} {
		go func(i int, s *store.Store) {
			<-start
			_, err := s.AcceptInvite(token, []string{"first-user", "second-user"}[i], "synthetic-concurrent-password")
			results <- err
		}(i, s)
	}
	close(start)
	// The writer's bounded contention window lets both bcrypt verifications run
	// before either account can commit. No private repository hook is involved.
	time.Sleep(time.Second)
	unlock()
	accepted := 0
	for range 2 {
		if <-results == nil {
			accepted++
		}
	}
	if accepted != 1 {
		t.Fatalf("single-use invitation created %d accounts; want exactly one", accepted)
	}
}

func TestMFAEnrollmentCannotBeBypassedWithAnEarlierAccountSnapshot(t *testing.T) {
	first, second, _ := identityHandles(t)
	const password = "synthetic-concurrent-password"
	if err := first.EnsureAdmin("operator", password); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	before, _, oldToken, err := first.Login("operator", password, "", now)
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := second.BeginMFA(before.ID, password, now)
	if err != nil {
		t.Fatal(err)
	}
	code, err := totp.GenerateCode(secret, now)
	if err != nil {
		t.Fatal(err)
	}
	_, _, enrolledToken, err := second.EnableMFA(before.ID, code, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = first.NewSession(before, now); err == nil {
		t.Fatal("pre-MFA account snapshot created an authenticated session after enrollment")
	}
	if _, _, err = first.ResolveSession(oldToken, now); err == nil {
		t.Fatal("MFA enrollment left the old session usable across store handles")
	}
	if _, _, err = first.ResolveSession(enrolledToken, now); err != nil {
		t.Fatalf("MFA-confirmed replacement session unavailable: %v", err)
	}
}

func TestConcurrentMFASetupCannotUndoCompletedEnrollment(t *testing.T) {
	first, second, _ := identityHandles(t)
	const password = "synthetic-concurrent-password"
	if err := first.EnsureAdmin("operator", password); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	secret, _, err := first.BeginMFA("admin", password, now)
	if err != nil {
		t.Fatal(err)
	}
	code, err := totp.GenerateCode(secret, now)
	if err != nil {
		t.Fatal(err)
	}
	setupDone := make(chan error, 1)
	go func() {
		_, _, err := first.BeginMFA("admin", password, now)
		setupDone <- err
	}()
	// Setup's password verification is deliberately expensive. The competing
	// enable operation must fence it even if setup already read the old account.
	time.Sleep(10 * time.Millisecond)
	_, _, token, enableErr := second.EnableMFA("admin", code, now)
	setupErr := <-setupDone
	if enableErr != nil {
		// If setup committed first, its new secret legitimately replaces the old
		// pending challenge. That outcome must not claim enrollment succeeded.
		if setupErr != nil {
			t.Fatalf("neither competing MFA operation succeeded: setup=%v enable=%v", setupErr, enableErr)
		}
		return
	}
	if setupErr == nil {
		t.Fatal("stale MFA setup succeeded after the earlier challenge was enabled")
	}
	account, _, err := first.ResolveSession(token, now)
	if err != nil || account.TOTPSecret == "" || account.PendingTOTPSecret != "" {
		t.Fatalf("completed MFA enrollment was overwritten: %v", err)
	}
	if _, _, _, err := first.Login("operator", password, "", now); err == nil {
		t.Fatal("concurrent setup disabled MFA on a successfully enrolled account")
	}
}

func TestMFAEnrollmentCompletesOnceAcrossContendingStoreHandles(t *testing.T) {
	first, second, writer := identityHandles(t)
	const password = "synthetic-concurrent-password"
	if err := first.EnsureAdmin("operator", password); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	secret, _, err := first.BeginMFA("admin", password, now)
	if err != nil {
		t.Fatal(err)
	}
	code, err := totp.GenerateCode(secret, now)
	if err != nil {
		t.Fatal(err)
	}
	unlock := holdIdentityWriter(t, writer)
	type outcome struct {
		token string
		err   error
	}
	results := make(chan outcome, 2)
	for _, s := range []*store.Store{first, second} {
		go func() {
			_, _, token, err := s.EnableMFA("admin", code, now)
			results <- outcome{token, err}
		}()
	}
	time.Sleep(100 * time.Millisecond)
	unlock()
	accepted := 0
	for range 2 {
		result := <-results
		if result.err == nil {
			accepted++
			if _, _, err := first.ResolveSession(result.token, now); err != nil {
				t.Fatalf("successful MFA session was revoked by the competing attempt: %v", err)
			}
		} else if result.token != "" {
			t.Fatal("failed MFA enrollment returned an authenticated token")
		}
	}
	if accepted != 1 {
		t.Fatalf("MFA challenge completed %d times; want exactly once", accepted)
	}
}
