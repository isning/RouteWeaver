package store_test

import (
	"encoding/json"
	"routeweaver/internal/store"
	"testing"
)

func TestReviewTokensArePrivatePurposeBoundAndCanonical(t *testing.T) {
	a, e := store.Open(t.TempDir()+"/a.db", make([]byte, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	key := make([]byte, 32)
	key[0] = 1
	b, e := store.Open(t.TempDir()+"/b.db", key)
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	x := json.RawMessage(`{"password":"synthetic","n":9007199254740993}`)
	y := json.RawMessage(`{"n":9007199254740993, "password":"synthetic"}`)
	first, e := a.ReviewToken("record/deployment/a", x)
	if e != nil {
		t.Fatal(e)
	}
	same, _ := a.ReviewToken("record/deployment/a", y)
	other, _ := a.ReviewToken("record/deployment/b", x)
	keyed, _ := b.ReviewToken("record/deployment/a", x)
	if first != same || first == other || first == keyed {
		t.Fatal("token context or canonicalization failed")
	}
}
