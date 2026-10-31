package store_test

import (
	"bytes"
	"fmt"
	"path/filepath"
	"routeweaver/internal/domain"
	"routeweaver/internal/store"
	"runtime"
	"strings"
	"testing"
)

// State is a small operational view, not a scan of private sources and the
// entire immutable accounting history. Keep work independent of unrelated rows.
func TestStateReadsOnlyOperationalKinds(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{29}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.PutUser(domain.User{ID: "account", Name: "Fixture", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	large := map[string]string{"payload": strings.Repeat("x", 64<<10)}
	for i := 0; i < 128; i++ {
		if err := s.Put("unrelated-history", fmt.Sprint(i), large); err != nil {
			t.Fatal(err)
		}
	}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	view, err := s.State()
	runtime.ReadMemStats(&after)
	if err != nil || len(view.Users) != 1 {
		t.Fatalf("state changed: %+v %v", view, err)
	}
	allocated := after.TotalAlloc - before.TotalAlloc
	if allocated > 2<<20 {
		t.Fatalf("small operational view allocated %d bytes scanning unrelated history", allocated)
	}
}
