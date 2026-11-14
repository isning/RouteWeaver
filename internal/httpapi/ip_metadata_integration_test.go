package httpapi_test

import "testing"

func TestInsightsIPMetadataExplicitlyUnavailableWithoutDatabase(t *testing.T) {
	s, srv := makeServer(t)
	a := inviteClient(t, s, srv, "metadata-optional")
	code, body, raw := req(t, a.c, "GET", srv.URL+"/api/me/insights", "", nil)
	if code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	metadata, ok := body["ipMetadata"].(map[string]any)
	if !ok || metadata["available"] != false {
		t.Fatalf("must explicitly report unavailable: %s", raw)
	}
	if len(metadata["items"].([]any)) != 0 || len(metadata["sources"].([]any)) != 0 {
		t.Fatalf("unexpected metadata: %s", raw)
	}
}
