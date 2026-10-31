package store_test

import (
	"bytes"
	"path/filepath"
	"routeweaver/internal/store"
	"testing"
	"time"
)

func TestUnknownAndDisabledLoginDoPasswordWork(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{51}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if e = s.EnsureAdmin("work-admin", "synthetic-work-password"); e != nil {
		t.Fatal(e)
	}
	measure := func(name string) time.Duration {
		start := time.Now()
		for i := 0; i < 3; i++ {
			if _, _, _, e = s.Login(name, "incorrect-password", "", time.Now()); e == nil {
				t.Fatal("invalid login accepted")
			}
		}
		return time.Since(start)
	}
	known := measure("work-admin")
	unknown := measure("missing-admin")
	var a store.Account
	if e = s.Get("accounts", "admin", &a); e != nil {
		t.Fatal(e)
	}
	a.Disabled = true
	if e = s.Put("accounts", a.ID, a); e != nil {
		t.Fatal(e)
	}
	disabled := measure("work-admin")
	// A deliberately broad lower bound catches the previous near-zero shortcut;
	// this is not a constant-time proof or a latency performance target.
	if unknown < known/4 || disabled < known/4 {
		t.Fatalf("bcrypt work shortcut: known=%s unknown=%s disabled=%s", known, unknown, disabled)
	}
}
