package conversion_test

import (
	"routeweaver/internal/conversion"
	"routeweaver/internal/domain"
	"testing"
)

func TestSourceRenameUsesHumanLabelNotInternalSourceID(t *testing.T) {
	collection := domain.Collection{ID: "collection", Name: "Personal", OwnerID: "alice", Sources: []domain.CollectionSource{{SourceID: "source_opaque", Steps: []domain.ProcessingStep{{ID: "rename", Kind: "rename", Enabled: true, Template: "{source} · {name}"}}}}}
	snapshot := domain.SourceSnapshot{SourceID: "source_opaque", SourceName: "我的机场", SnapshotID: "one", OwnerID: "alice", Endpoints: []domain.ClientEndpoint{{ID: "node", Name: "UK", OwnerID: "alice", Origin: "imported", Connection: domain.Connection{Protocol: "socks", Host: "example.com", Port: 1080}}}}
	result, err := conversion.ProcessCollection(collection, []domain.SourceSnapshot{snapshot})
	if err != nil {
		t.Fatal(err)
	}
	if result.Endpoints[0].Name != "我的机场 · UK" {
		t.Fatalf("internal ID leaked into friendly naming: %s", result.Endpoints[0].Name)
	}
}
