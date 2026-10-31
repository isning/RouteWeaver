package httpapi

import (
	"context"
	"errors"
	"fmt"
	"routeweaver/internal/resources"
	"testing"
)

func TestSourceFailureCodeClassifiesTypedErrorsOnly(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{resources.ErrURL, "source_url_not_allowed"},
		{resources.ErrAddress, "source_address_not_public"},
		{resources.ErrFetch, "source_fetch_failed"},
		{resources.ErrTooLarge, "source_content_too_large"},
		{context.DeadlineExceeded, "source_fetch_timeout"},
		{errSourceParse, "source_parse_failed"},
		{errSourceIncomplete, "source_import_incomplete"},
		{context.Canceled, ""},
		{errors.New("resource URL is not allowed"), ""},
		{errors.New("https://private.example?token=synthetic-secret"), ""},
	} {
		for _, err := range []error{tc.err, fmt.Errorf("wrapped: %w", tc.err)} {
			if got := sourceFailureCode(err); got != tc.want {
				t.Fatalf("typed classification %T got %q want %q", tc.err, got, tc.want)
			}
		}
	}
	if got := sourceFailureCode(nil); got != "" {
		t.Fatalf("nil error: %q", got)
	}
}

func TestSourceFailureCodeProjectionRequiresCurrentFailure(t *testing.T) {
	for _, reveal := range []bool{false, true} {
		for _, tc := range []struct {
			status, detail, code string
			want                 bool
		}{
			{"failed", "safe error", "source_url_not_allowed", true},
			{"failed", "", "source_url_not_allowed", false},
			{"failed", "safe error", "constructor", false},
			{"failed", "safe error", "__proto__", false},
			{"accepted", "stale error", "source_url_not_allowed", false},
			{"", "legacy error", "source_url_not_allowed", false},
			{"unknown-status", "safe error", "source_url_not_allowed", false},
		} {
			source := Source{RefreshStatus: tc.status, LastError: tc.detail, LastErrorCode: tc.code}
			got := sourceView(source, reveal)
			if tc.want && got.LastErrorCode != tc.code || !tc.want && got.LastErrorCode != "" {
				t.Fatalf("projection %+v reveal=%t got %q", tc, reveal, got.LastErrorCode)
			}
			if source.LastErrorCode != tc.code {
				t.Fatal("projection mutated persisted source")
			}
			if got.LastError != tc.detail {
				t.Fatal("compatibility detail changed")
			}
		}
	}
}
