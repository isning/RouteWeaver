package auth

import (
	"strings"
	"testing"
	"time"
)

func TestIndependentCorruptCost10HashStillDoesPasswordWork(t *testing.T) {
	measure := func(hash []byte) time.Duration {
		start := time.Now()
		for i := 0; i < 3; i++ {
			if CheckPassword(hash, "synthetic-wrong-password") {
				t.Fatal("invalid credential accepted")
			}
		}
		return time.Since(start)
	}
	dummy := measure(nil)
	corrupt := measure([]byte("$2a$10$" + strings.Repeat("!", 53)))
	t.Logf("dummy=%s corrupt-cost10=%s", dummy, corrupt)
	if corrupt < dummy/4 {
		t.Fatal("corrupt default-cost bcrypt hash skips promised dummy work")
	}
}
