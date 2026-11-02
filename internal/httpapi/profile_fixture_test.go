package httpapi_test

import "testing"

// Fixture-only updates deliberately start from the current stored draft. Tests
// exercising opened-editor, missing-precondition, or concurrent-write behavior
// must capture their own token and call putOpenedProfile instead.
func currentProfileRevision(t *testing.T, owner sessionClient, url string) string {
	t.Helper()
	code, current, body := req(t, owner.c, "GET", url, "", nil)
	if code != 200 {
		t.Fatalf("read profile fixture baseline: %d %s", code, body)
	}
	revision, ok := current["revisionToken"].(string)
	if !ok || revision == "" {
		t.Fatal("profile fixture baseline has no revision token")
	}
	return revision
}

func putCurrentProfileDraft(t *testing.T, owner sessionClient, url string, value any) (int, map[string]any, string) {
	t.Helper()
	return putOpenedProfile(t, owner, url, currentProfileRevision(t, owner, url), value)
}

func saveCurrentProfileDraft(t *testing.T, owner sessionClient, url string, value any) map[string]any {
	t.Helper()
	code, saved, body := putCurrentProfileDraft(t, owner, url, value)
	if code != 200 {
		t.Fatalf("save current profile fixture: %d %s", code, body)
	}
	return saved
}
