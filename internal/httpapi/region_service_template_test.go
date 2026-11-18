package httpapi_test

import (
	"encoding/json"
	"os"
	"routeweaver/internal/reuse"
	"testing"
)

func TestRegionServiceTemplatePublishesThroughValidatedCatalog(t *testing.T) {
	raw, err := os.ReadFile("../../templates/region-service-routing.json")
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Kind string     `json:"kind"`
		Spec reuse.Spec `json:"spec"`
	}
	if err = json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	if err = reuse.Validate(input.Kind, input.Spec); err != nil {
		t.Fatal(err)
	}
	_, srv := makeServer(t)
	var payload map[string]any
	if err = json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	status, _, body := adminTemplateRequest(t, srv, payload)
	if status != 201 {
		t.Fatalf("publish failed: %d %s", status, body)
	}
}
