package httpapi

import (
	"strings"
	"testing"

	"routeweaver/internal/domain"
)

func TestAttributedOutputRevisionPreservesEveryTokenPrefix(t *testing.T) {
	// Exercise every possible first base64url character, including the two that
	// caused real provisioning to fail. No randomness or retry hides this defect.
	for _, first := range "-_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" {
		token := string(first) + strings.Repeat("A", 42)
		revision := attributedOutputRevision(token)
		if !domain.ValidID(revision) {
			t.Fatalf("token prefix %q produced invalid revision %q", first, revision)
		}
		if !strings.HasPrefix(revision, "or_") || strings.TrimPrefix(revision, "or_") != token {
			t.Fatal("revision discarded token entropy")
		}
	}
}
