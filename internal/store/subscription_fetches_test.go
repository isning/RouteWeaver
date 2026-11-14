package store_test

import (
	"bytes"
	"path/filepath"
	"routeweaver/internal/store"
	"sync"
	"testing"
	"time"
)

func TestSubscriptionFetchHistoryIsBoundedPrivateAndPersistent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{22}, 32)
	s, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for i := 0; i < 105; i++ {
		if err := s.RecordSubscriptionFetch("alice", store.SubscriptionFetch{OutputID: "phone", At: now.Add(time.Duration(i) * time.Second), Delivery: "feed"}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.SubscriptionFetches("alice", now.Add(105*time.Second))
	if err != nil || len(got.Items) != 100 {
		t.Fatalf("history %d %v", len(got.Items), err)
	}
	if got.Items[0].At != now.Add(104*time.Second) || got.Items[99].At != now.Add(5*time.Second) {
		t.Fatal("wrong ordering/retention")
	}
	other, err := s.SubscriptionFetches("bob", now)
	if err != nil || len(other.Items) != 0 {
		t.Fatal("cross-owner history")
	}
	s.Close()
	s, err = store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err = s.SubscriptionFetches("alice", now.Add(105*time.Second))
	if err != nil || len(got.Items) != 100 {
		t.Fatal("not persistent")
	}
	got, err = s.SubscriptionFetches("alice", now.Add(31*24*time.Hour))
	if err != nil || len(got.Items) != 0 {
		t.Fatal("expired events visible")
	}
	if err = s.RecordSubscriptionFetch("a/b", store.SubscriptionFetch{OutputID: "phone", At: now, Delivery: "feed"}); err == nil {
		t.Fatal("invalid owner")
	}
}

func TestSubscriptionFetchHistorySerializesIndependentStores(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{23}, 32)
	first, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for _, s := range []*store.Store{first, second} {
		wg.Add(1)
		go func(s *store.Store) {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				errs <- s.RecordSubscriptionFetch("owner", store.SubscriptionFetch{OutputID: "phone", At: time.Now().UTC(), Delivery: "feed"})
			}
		}(s)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	history, err := first.SubscriptionFetches("owner", time.Now().UTC())
	if err != nil || len(history.Items) != 40 {
		t.Fatalf("lost concurrent update: %d %v", len(history.Items), err)
	}
}

func TestSubscriptionFetchSourceAlertsOptInResetAndBoundaries(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{33}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().UTC()
	add := func(output, ip string, at time.Time) {
		t.Helper()
		if err := s.RecordSubscriptionFetch("owner", store.SubscriptionFetch{OutputID: output, SourceIP: ip, At: at, Delivery: "feed"}); err != nil {
			t.Fatal(err)
		}
	}
	read := func() store.SubscriptionFetchHistory {
		t.Helper()
		h, e := s.SubscriptionFetches("owner", now)
		if e != nil {
			t.Fatal(e)
		}
		return h
	}
	add("phone", "192.0.2.1", now)
	if read().Items[0].SourceIP != "" {
		t.Fatal("default retained IP")
	}
	if err := s.SetSubscriptionFetchSourceTracking("owner", true, now); err != nil {
		t.Fatal(err)
	}
	add("phone", "::ffff:192.0.2.1", now.Add(time.Second))
	if read().Items[0].NewSource || read().Items[0].SourceIP != "192.0.2.1" {
		t.Fatal("baseline/canonicalization")
	}
	add("phone", "192.0.2.1", now.Add(2*time.Second))
	if read().Items[0].NewSource {
		t.Fatal("repeat address")
	}
	add("phone", "192.0.2.2", now.Add(3*time.Second))
	if !read().Items[0].NewSource {
		t.Fatal("new address missing")
	}
	add("other", "192.0.2.3", now.Add(4*time.Second))
	if read().Items[0].NewSource {
		t.Fatal("cross-output baseline")
	}
	add("phone", "unknown-peer", now.Add(5*time.Second))
	if read().Items[0].SourceIP != "" || read().Items[0].NewSource {
		t.Fatal("invalid IP retained")
	}
	if err := s.SetSubscriptionFetchSourceTracking("owner", false, now); err != nil {
		t.Fatal(err)
	}
	for _, x := range read().Items {
		if x.SourceIP != "" || x.NewSource {
			t.Fatal("disable did not clear")
		}
	}
	if read().TrackSourceIPs {
		t.Fatal("still enabled")
	}
	if err := s.SetSubscriptionFetchSourceTracking("owner", true, now); err != nil {
		t.Fatal(err)
	}
	add("phone", "192.0.2.2", now.Add(6*time.Second))
	if read().Items[0].NewSource {
		t.Fatal("reenable did not reset baseline")
	}
	add("phone", "192.0.2.8", now.Add(31*24*time.Hour))
	if read().Items[0].NewSource {
		t.Fatal("expired baseline used")
	}
}

func TestSubscriptionFetchDisableSerializesWithAppendAcrossStores(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{34}, 32)
	first, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer first.Close()
	second, e := store.Open(path, key)
	if e != nil {
		t.Fatal(e)
	}
	defer second.Close()
	now := time.Now().UTC()
	for i := 0; i < 10; i++ {
		if e = first.SetSubscriptionFetchSourceTracking("owner", true, now); e != nil {
			t.Fatal(e)
		}
		start := make(chan struct{})
		errs := make(chan error, 2)
		go func() { <-start; errs <- first.SetSubscriptionFetchSourceTracking("owner", false, now) }()
		go func() {
			<-start
			errs <- second.RecordSubscriptionFetch("owner", store.SubscriptionFetch{OutputID: "phone", At: now, Delivery: "feed", SourceIP: "192.0.2.1"})
		}()
		close(start)
		for j := 0; j < 2; j++ {
			if e = <-errs; e != nil {
				t.Fatal(e)
			}
		}
		h, e := first.SubscriptionFetches("owner", now)
		if e != nil {
			t.Fatal(e)
		}
		if h.TrackSourceIPs {
			t.Fatal("disable lost")
		}
		for _, x := range h.Items {
			if x.SourceIP != "" || x.NewSource {
				t.Fatal("racing fetch repopulated disabled addresses")
			}
		}
	}
}
