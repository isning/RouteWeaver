package conversion_test

import (
	"reflect"
	"testing"

	"routeweaver/internal/conversion"
	"routeweaver/internal/domain"
)

func pipelineIDs(nodes []domain.ClientEndpoint) []string {
	out := make([]string, len(nodes))
	for i, node := range nodes {
		out[i] = node.ID
	}
	return out
}

func TestProcessingStableSortPreservesEqualKeySourceOrder(t *testing.T) {
	input := []domain.SourceSnapshot{
		{SourceID: "first", SnapshotID: "s1", OwnerID: "u", Endpoints: []domain.ClientEndpoint{endpoint("a", "B", "US"), endpoint("b", "A", "UK")}},
		{SourceID: "second", SnapshotID: "s2", OwnerID: "u", Endpoints: []domain.ClientEndpoint{endpoint("c", "B", "US"), endpoint("d", "A", "UK")}},
	}
	for _, field := range []string{"name", "region", "protocol"} {
		for _, descending := range []bool{false, true} {
			for _, reverseSources := range []bool{false, true} {
				t.Run(field+map[bool]string{false: "/ascending", true: "/descending"}[descending]+map[bool]string{false: "/original", true: "/reordered"}[reverseSources], func(t *testing.T) {
					sources := []domain.CollectionSource{{SourceID: "first"}, {SourceID: "second"}}
					want := []string{"b", "d", "a", "c"}
					if descending {
						want = []string{"a", "c", "b", "d"}
					}
					if reverseSources {
						sources[0], sources[1] = sources[1], sources[0]
						want = []string{"d", "b", "c", "a"}
						if descending {
							want = []string{"c", "a", "d", "b"}
						}
					}
					if field == "protocol" {
						want = []string{"a", "b", "c", "d"}
						if reverseSources {
							want = []string{"c", "d", "a", "b"}
						}
					}
					result, err := conversion.ProcessCollection(domain.Collection{ID: "col", Name: "Mine", OwnerID: "u", Sources: sources, Steps: []domain.ProcessingStep{{ID: "sort", Enabled: true, Kind: "sort", SortBy: field, Descending: descending}}}, input)
					if err != nil {
						t.Fatal(err)
					}
					if got := pipelineIDs(result.Endpoints); !reflect.DeepEqual(got, want) {
						t.Fatalf("stable %s order: got %v want %v", field, got, want)
					}
					stage := result.Stages[len(result.Stages)-1]
					if stage.Scope != "aggregate" || stage.StepID != "sort" || len(stage.ChangedIDs) != 0 || len(stage.RemovedIDs) != 0 {
						t.Fatalf("sort must reorder without claiming content edits/removal: %#v", stage)
					}
				})
			}
		}
	}
}

func TestProcessingStepOrderAndDisabledStepsAreExplicit(t *testing.T) {
	input := []domain.SourceSnapshot{{SourceID: "source", SnapshotID: "s1", OwnerID: "u", Endpoints: []domain.ClientEndpoint{endpoint("a", "A", "UK"), endpoint("b", "B", "US")}}}
	rename := domain.ProcessingStep{ID: "rename", Kind: "rename", Enabled: true, Template: "Chosen", Filter: domain.EndpointFilter{Region: "UK"}}
	keep := domain.ProcessingStep{ID: "keep", Kind: "keep", Enabled: true, Filter: domain.EndpointFilter{NamePattern: "^Chosen$"}}
	disabled := domain.ProcessingStep{ID: "disabled-drop", Kind: "drop", Enabled: false}
	for _, scenario := range []struct {
		name   string
		steps  []domain.ProcessingStep
		want   []string
		stages []string
	}{
		{"rename then keep", []domain.ProcessingStep{rename, disabled, keep}, []string{"a"}, []string{"rename", "keep"}},
		{"keep then rename", []domain.ProcessingStep{keep, disabled, rename}, []string{}, []string{"keep", "rename"}},
		{"disabled rename", []domain.ProcessingStep{{ID: "rename", Kind: "rename", Enabled: false, Template: "Chosen"}, keep}, []string{}, []string{"keep"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			got, err := conversion.ProcessCollection(domain.Collection{ID: "col", Name: "Mine", OwnerID: "u", Sources: []domain.CollectionSource{{SourceID: "source", Steps: scenario.steps}}}, input)
			if err != nil {
				t.Fatal(err)
			}
			if ids := pipelineIDs(got.Endpoints); !reflect.DeepEqual(ids, scenario.want) {
				t.Fatalf("step order: %v want %v", ids, scenario.want)
			}
			ids := []string{}
			for _, stage := range got.Stages {
				if stage.StepID != "" {
					ids = append(ids, stage.StepID)
					if stage.Scope != "source" || stage.SourceID != "source" {
						t.Fatalf("lost stage attribution: %#v", stage)
					}
				}
			}
			if !reflect.DeepEqual(ids, scenario.stages) {
				t.Fatalf("disabled step emitted or active order changed: %v", ids)
			}
			if input[0].Endpoints[0].Name != "A" || len(input[0].Endpoints) != 2 {
				t.Fatal("processing changed accepted input")
			}
		})
	}
}

func TestProcessingStageChangesIdentifyExactContentAndRemoval(t *testing.T) {
	a, b, c := endpoint("a", "A", "UK"), endpoint("b", "B", "UK"), endpoint("c", "C", "US")
	b.Connection = a.Connection
	input := []domain.SourceSnapshot{{SourceID: "source", SnapshotID: "s1", OwnerID: "u", Endpoints: []domain.ClientEndpoint{a, b, c}}}
	collection := domain.Collection{ID: "col", Name: "Mine", OwnerID: "u", Sources: []domain.CollectionSource{{SourceID: "source"}}, Steps: []domain.ProcessingStep{
		{ID: "rename", Kind: "rename", Enabled: true, Template: "Changed", Filter: domain.EndpointFilter{Region: "US"}},
		{ID: "same-name", Kind: "rename", Enabled: true, Template: "{name}"},
		{ID: "dedup", Kind: "deduplicate", Enabled: true},
		{ID: "drop", Kind: "drop", Enabled: true, Filter: domain.EndpointFilter{Region: "US"}},
	}}
	got, err := conversion.ProcessCollection(collection, input)
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]struct{ changed, removed, order []string }{
		"rename":    {[]string{"c"}, []string{}, []string{"a", "b", "c"}},
		"same-name": {[]string{}, []string{}, []string{"a", "b", "c"}},
		"dedup":     {[]string{"a"}, []string{"b"}, []string{"a", "c"}},
		"drop":      {[]string{}, []string{"c"}, []string{"a"}},
	}
	for _, stage := range got.Stages {
		want, ok := expected[stage.StepID]
		if !ok {
			continue
		}
		if !reflect.DeepEqual(stage.ChangedIDs, want.changed) || !reflect.DeepEqual(stage.RemovedIDs, want.removed) || !reflect.DeepEqual(pipelineIDs(stage.Endpoints), want.order) {
			t.Fatalf("incorrect %s change explanation: %#v", stage.StepID, stage)
		}
		if stage.StepID == "rename" && (stage.Endpoints[0].Name != "A" || stage.Endpoints[1].Name != "B" || stage.Endpoints[2].Name != "Changed") {
			t.Fatal("rename reason does not correspond to exact matching endpoint content")
		}
		if stage.StepID == "dedup" && len(stage.Endpoints[0].Provenance) != 2 {
			t.Fatal("dedup changed reason must correspond to merged provenance")
		}
		delete(expected, stage.StepID)
	}
	if len(expected) != 0 {
		t.Fatalf("missing stage explanations: %v", expected)
	}
	if !reflect.DeepEqual(input[0].Endpoints, []domain.ClientEndpoint{a, b, c}) {
		t.Fatal("preview mutated accepted snapshot")
	}
}
