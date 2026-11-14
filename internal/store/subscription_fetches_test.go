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
