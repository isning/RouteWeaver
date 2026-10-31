package conversion_test

import (
	"routeweaver/internal/conversion"
	"routeweaver/internal/domain"
	"testing"
)

func endpoint(id, name, region string) domain.ClientEndpoint {
	return domain.ClientEndpoint{ID: id, Name: name, OwnerID: "u", Origin: "imported", Region: region, Connection: domain.Connection{Host: id + ".example", Port: 1080, Protocol: "socks"}}
}
func TestSourceProcessingThenOrderedMergeThenAggregate(t *testing.T) {
	a := endpoint("a", "A", "UK")
	b := endpoint("b", "B", "US")
	c := endpoint("c", "C", "UK")
	input := []domain.SourceSnapshot{{SourceID: "first", SnapshotID: "s1", OwnerID: "u", Endpoints: []domain.ClientEndpoint{a, b}}, {SourceID: "second", SnapshotID: "s2", OwnerID: "u", Endpoints: []domain.ClientEndpoint{c}}}
	collection := domain.Collection{ID: "col", Name: "Mine", OwnerID: "u", Sources: []domain.CollectionSource{{SourceID: "first", Steps: []domain.ProcessingStep{{ID: "keep", Enabled: true, Kind: "keep", Filter: domain.EndpointFilter{Region: "UK"}}, {ID: "rename", Enabled: true, Kind: "rename", Template: "{name}-source"}}}, {SourceID: "second"}}, Steps: []domain.ProcessingStep{{ID: "all", Enabled: true, Kind: "rename", Template: "{name}-aggregate"}}}
	got, err := conversion.ProcessCollection(collection, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Endpoints) != 2 || got.Endpoints[0].Name != "A-source-aggregate" || got.Endpoints[1].Name != "C-aggregate" {
		t.Fatalf("bad pipeline: %#v", got.Endpoints)
	}
	if input[0].Endpoints[0].Name != "A" {
		t.Fatal("mutated source")
	}
	if len(got.Stages) != 8 {
		t.Fatalf("want raw/source-step/source-result/merged/aggregate previews: %d", len(got.Stages))
	}
	if got.Stages[1].Endpoints[0].Connection.Password != "" {
		t.Fatal("preview credential leak")
	}
}

func TestDedupUsesConnectionNotDisplayNameAndKeepsProvenance(t *testing.T) {
	a := endpoint("a", "Same", "UK")
	b := endpoint("b", "Different label", "UK")
	b.Connection = a.Connection
	c := endpoint("c", "Same", "UK")
	got, err := conversion.ProcessCollection(domain.Collection{ID: "col", Name: "Mine", OwnerID: "u", Sources: []domain.CollectionSource{{SourceID: "one"}, {SourceID: "two"}}, Steps: []domain.ProcessingStep{{ID: "dedup", Kind: "deduplicate", Enabled: true}}}, []domain.SourceSnapshot{{SourceID: "one", SnapshotID: "s1", OwnerID: "u", Endpoints: []domain.ClientEndpoint{a}}, {SourceID: "two", SnapshotID: "s2", OwnerID: "u", Endpoints: []domain.ClientEndpoint{b, c}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Endpoints) != 2 || got.Endpoints[0].ID != "a" || got.Endpoints[1].ID != "c" {
		t.Fatalf("dedup confused names with connections: %#v", got.Endpoints)
	}
	if len(got.Endpoints[0].Provenance) != 2 {
		t.Fatal("dedup erased source provenance")
	}
	if got.Stages[len(got.Stages)-1].RemovedIDs[0] != "b" {
		t.Fatal("preview must explain removed member")
	}
}
func TestPreviewRedactsSecretsWithoutMutatingAcceptedSnapshot(t *testing.T) {
	e := endpoint("a", "VLESS", "UK")
	e.Connection = domain.Connection{Host: "example.com", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", TLS: &domain.TLSOptions{Enabled: true, ServerName: "example.com", Fingerprint: "chrome", Reality: &domain.RealityOptions{PublicKey: "ZCBkxteC4GSHx-8OeSWgGTcJfD-KQYJgKfAnPcnL_q0", ShortID: "abcdef"}}}
	s := domain.SourceSnapshot{SourceID: "one", SnapshotID: "s1", OwnerID: "u", Endpoints: []domain.ClientEndpoint{e}}
	got, err := conversion.ProcessCollection(domain.Collection{ID: "col", Name: "Mine", OwnerID: "u", Sources: []domain.CollectionSource{{SourceID: "one"}}}, []domain.SourceSnapshot{s})
	if err != nil {
		t.Fatal(err)
	}
	for _, stage := range got.Stages {
		if stage.Endpoints[0].Connection.UUID != "" || stage.Endpoints[0].Connection.TLS.Reality.ShortID != "" {
			t.Fatal("credential leaked in preview")
		}
	}
	if s.Endpoints[0].Connection.UUID == "" || s.Endpoints[0].Connection.TLS.Reality.ShortID != "abcdef" || got.Endpoints[0].Connection.UUID == "" {
		t.Fatal("preview mutated source/export")
	}
}
func TestCollectionOwnershipAndInvalidStepFailClosed(t *testing.T) {
	e := endpoint("a", "A", "UK")
	s := domain.SourceSnapshot{SourceID: "one", SnapshotID: "s1", OwnerID: "other", Endpoints: []domain.ClientEndpoint{e}}
	c := domain.Collection{ID: "col", Name: "Mine", OwnerID: "u", Sources: []domain.CollectionSource{{SourceID: "one"}}}
	if _, err := conversion.ProcessCollection(c, []domain.SourceSnapshot{s}); err == nil {
		t.Fatal("cross-owner source accepted")
	}
	s.OwnerID = "u"
	c.Steps = []domain.ProcessingStep{{ID: "bad", Enabled: true, Kind: "keep", Filter: domain.EndpointFilter{NamePattern: "["}}}
	if _, err := conversion.ProcessCollection(c, []domain.SourceSnapshot{s}); err == nil {
		t.Fatal("bad filter silently removed data")
	}
}

func TestTransportHeaderSecretsRemainIsolatedFromPreviewAndInput(t *testing.T) {
	e := endpoint("a", "A", "UK")
	e.Connection = domain.Connection{Host: "proxy.example", Port: 443, Protocol: "vless", UUID: "00000000-0000-4000-8000-000000000001", Transport: &domain.TransportOptions{Type: "ws", Headers: map[string]string{"X-Token": "secret-fixture"}}}
	collection := domain.Collection{ID: "col", Name: "Mine", OwnerID: "u", Sources: []domain.CollectionSource{{SourceID: "source"}}}
	result, err := conversion.ProcessCollection(collection, []domain.SourceSnapshot{{SourceID: "source", SnapshotID: "s1", OwnerID: "u", Endpoints: []domain.ClientEndpoint{e}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, stage := range result.Stages {
		for _, node := range stage.Endpoints {
			if node.Connection.Transport != nil && len(node.Connection.Transport.Headers) > 0 {
				t.Fatal("preview leaked transport headers")
			}
		}
	}
	result.Endpoints[0].Connection.Transport.Headers["X-Token"] = "changed"
	if e.Connection.Transport.Headers["X-Token"] != "secret-fixture" {
		t.Fatal("output mutation changed input snapshot")
	}
}
