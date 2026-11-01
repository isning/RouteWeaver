package conversion_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"routeweaver/internal/conversion"
	"routeweaver/internal/domain"
)

func overridePointer[T any](value T) *T { return &value }

func overrideFixture() (domain.Collection, []domain.SourceSnapshot) {
	a := endpoint("a", "A", "UK")
	a.Tags = []string{"original"}
	a.Connection.Username, a.Connection.Password = "fixture-user", "fixture-password"
	a.Provenance = []domain.SourceRef{{SourceID: "upstream", SnapshotID: "original", EndpointID: "original-a"}}
	b := endpoint("b", "B", "US")
	b.Tags = []string{"untouched"}
	return domain.Collection{ID: "col", Name: "Mine", OwnerID: "u", Sources: []domain.CollectionSource{{SourceID: "one"}}}, []domain.SourceSnapshot{{SourceID: "one", SourceName: "Provider", SnapshotID: "s1", OwnerID: "u", Endpoints: []domain.ClientEndpoint{a, b}}}
}

func overrideJSON(t *testing.T, value any) string {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestProcessCollectionOverrideSourceThenAggregatePreservesIdentityAndPreviews(t *testing.T) {
	c, input := overrideFixture()
	c.Sources[0].Steps = []domain.ProcessingStep{{ID: "source-override", Kind: "override", Enabled: true, Filter: domain.EndpointFilter{Region: "UK"}, Override: domain.EndpointOverride{Region: overridePointer("DE"), Tags: overridePointer([]string{"source"}), Host: overridePointer("source.example"), Port: overridePointer(2080)}}}
	c.Steps = []domain.ProcessingStep{{ID: "aggregate-override", Kind: "override", Enabled: true, Filter: domain.EndpointFilter{Region: "DE", Tags: []string{"source"}}, Override: domain.EndpointOverride{Region: overridePointer("JP"), Tags: overridePointer([]string{"aggregate"}), Host: overridePointer("aggregate.example"), Port: overridePointer(3080)}}}
	before := overrideJSON(t, input)
	collectionBefore := overrideJSON(t, c)
	got, err := conversion.ProcessCollection(c, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Endpoints) != 2 {
		t.Fatalf("want both endpoints, got %d", len(got.Endpoints))
	}
	want := input[0].Endpoints[0]
	want.Region, want.Tags = "JP", []string{"aggregate"}
	want.Connection.Host, want.Connection.Port = "aggregate.example", 3080
	want.Provenance = append(append([]domain.SourceRef{}, want.Provenance...), domain.SourceRef{SourceID: "one", SourceName: "Provider", SnapshotID: "s1", EndpointID: "a"})
	if !reflect.DeepEqual(got.Endpoints[0], want) {
		t.Fatalf("override changed more than allowed fields or lost precedence: %#v", got.Endpoints[0])
	}
	untouched := input[0].Endpoints[1]
	untouched.Provenance = []domain.SourceRef{{SourceID: "one", SourceName: "Provider", SnapshotID: "s1", EndpointID: "b"}}
	if !reflect.DeepEqual(got.Endpoints[1], untouched) {
		t.Fatal("filtered-out endpoint changed")
	}
	var source, aggregate *conversion.Stage
	for i := range got.Stages {
		s := &got.Stages[i]
		for _, e := range s.Endpoints {
			if e.Connection.Username != "" || e.Connection.Password != "" {
				t.Fatal("preview exposed credentials")
			}
		}
		if s.StepID == "source-override" {
			source = s
		}
		if s.StepID == "aggregate-override" {
			aggregate = s
		}
	}
	if source == nil || aggregate == nil {
		t.Fatal("override previews missing")
	}
	if source.Endpoints[0].Region != "DE" || source.Endpoints[0].Connection.Host != "source.example" || source.Endpoints[0].Connection.Port != 2080 || !reflect.DeepEqual(source.Endpoints[0].Tags, []string{"source"}) {
		t.Fatal("aggregate override mutated source-stage preview")
	}
	for _, s := range []*conversion.Stage{source, aggregate} {
		if !reflect.DeepEqual(s.ChangedIDs, []string{"a"}) || len(s.RemovedIDs) != 0 {
			t.Fatalf("preview did not explain only matched change: %#v", s)
		}
	}
	if overrideJSON(t, input) != before || overrideJSON(t, c) != collectionBefore {
		t.Fatal("processing mutated accepted input or override definition")
	}
	// Returned values and every preview are independent, not aliases of each other or caller-owned slices.
	snapshotsBefore := overrideJSON(t, got.Stages)
	got.Endpoints[0].Tags[0] = "output-change"
	got.Endpoints[0].Provenance[0].SourceID = "output-change"
	if overrideJSON(t, got.Stages) != snapshotsBefore {
		t.Fatal("output mutation changed preview")
	}
	outputBefore := overrideJSON(t, got.Endpoints)
	sourceBefore := overrideJSON(t, source)
	aggregate.Endpoints[0].Tags[0] = "preview-change"
	aggregate.Endpoints[0].Provenance[0].SourceID = "preview-change"
	if overrideJSON(t, got.Endpoints) != outputBefore || overrideJSON(t, source) != sourceBefore {
		t.Fatal("preview mutation changed output or earlier preview")
	}
	if overrideJSON(t, input) != before || overrideJSON(t, c) != collectionBefore {
		t.Fatal("output/preview mutation escaped into accepted input or override definition")
	}
}

func TestProcessCollectionOverrideNilTagsPreservesAndEmptyTagsClears(t *testing.T) {
	for _, tc := range []struct {
		name string
		tags *[]string
		want []string
	}{
		{"omitted", nil, []string{"original"}}, {"explicit-empty", overridePointer([]string{}), []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, input := overrideFixture()
			before := overrideJSON(t, input)
			c.Steps = []domain.ProcessingStep{{ID: "tags", Kind: "override", Enabled: true, Filter: domain.EndpointFilter{NamePattern: "^A$"}, Override: domain.EndpointOverride{Tags: tc.tags}}}
			got, err := conversion.ProcessCollection(c, input)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.Endpoints[0].Tags, tc.want) {
				t.Fatalf("tags = %#v, want %#v", got.Endpoints[0].Tags, tc.want)
			}
			if !reflect.DeepEqual(got.Endpoints[1].Tags, []string{"untouched"}) || overrideJSON(t, input) != before {
				t.Fatal("tag override changed unmatched endpoint or input")
			}
		})
	}
}

func TestProcessCollectionInvalidOverrideRejectsWithoutMutatingAcceptedInput(t *testing.T) {
	for _, scope := range []string{"source", "aggregate"} {
		for _, tc := range []struct {
			name     string
			override domain.EndpointOverride
		}{
			{"empty-host", domain.EndpointOverride{Host: overridePointer("")}},
			{"invalid-host", domain.EndpointOverride{Host: overridePointer("bad host")}},
			{"zero-port", domain.EndpointOverride{Port: overridePointer(0)}},
			{"negative-port", domain.EndpointOverride{Port: overridePointer(-1)}},
			{"oversized-port", domain.EndpointOverride{Port: overridePointer(65536)}},
		} {
			t.Run(scope+"/"+tc.name, func(t *testing.T) {
				c, input := overrideFixture()
				// A valid earlier change must not escape when the later override fails.
				steps := []domain.ProcessingStep{{ID: "valid", Kind: "override", Enabled: true, Override: domain.EndpointOverride{Tags: overridePointer([]string{"changed"})}}, {ID: "invalid", Kind: "override", Enabled: true, Filter: domain.EndpointFilter{NamePattern: "^B$"}, Override: tc.override}}
				if scope == "source" {
					c.Sources[0].Steps = steps
				} else {
					c.Steps = steps
				}
				before, collectionBefore := overrideJSON(t, input), overrideJSON(t, c)
				got, err := conversion.ProcessCollection(c, input)
				if err == nil || !strings.Contains(err.Error(), scope+".steps[1](invalid): invalid connection override") {
					t.Fatalf("want scoped override rejection, got %v", err)
				}
				if len(got.Endpoints) != 0 || len(got.Stages) != 0 {
					t.Fatal("failed processing exposed partial output")
				}
				if overrideJSON(t, input) != before || overrideJSON(t, c) != collectionBefore {
					t.Fatal("rejected override mutated accepted input or definition")
				}
				c.Sources[0].Steps, c.Steps = nil, nil
				accepted, err := conversion.ProcessCollection(c, input)
				if err != nil || len(accepted.Endpoints) != 2 || accepted.Endpoints[1].Connection.Host != "b.example" || accepted.Endpoints[1].Connection.Port != 1080 {
					t.Fatal("accepted snapshot no longer usable after rejection")
				}
			})
		}
	}
}
