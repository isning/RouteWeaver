package store_test

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"routeweaver/internal/store"
	"sync"
	"testing"
)

func TestComparedGenerationsFenceConcurrentFirstOwnershipAcrossStores(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	key := bytes.Repeat([]byte{36}, 32)
	first, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	compares := []store.RecordCompare{{Kind: "desired", ID: "entry"}, {Kind: "desired", ID: "exit"}}
	type result struct {
		owner       string
		generations map[string]uint64
		err         error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for i, s := range []*store.Store{first, second} {
		owner := []string{"route-one", "route-two"}[i]
		go func() {
			<-start
			generations, err := s.CompareSetsAndGenerateRecords("desired", []string{"entry", "exit"}, compares, nil, func(g map[string]uint64) ([]store.RecordWrite, error) {
				return []store.RecordWrite{
					{Kind: "desired", ID: "entry", Value: map[string]any{"generation": g["entry"], "owner": owner}},
					{Kind: "desired", ID: "exit", Value: map[string]any{"generation": g["exit"], "owner": owner}},
					{Kind: "ownership-attempts", ID: owner, Value: map[string]string{"owner": owner}},
				}, nil
			})
			results <- result{owner: owner, generations: generations, err: err}
		}()
	}
	close(start)
	winner, loser := "", ""
	for range 2 {
		r := <-results
		if r.err == nil {
			if winner != "" {
				t.Fatal("both owners claimed the same instances")
			}
			winner = r.owner
			if !reflect.DeepEqual(r.generations, map[string]uint64{"entry": 1, "exit": 1}) {
				t.Fatalf("first generations = %v", r.generations)
			}
		} else if errors.Is(r.err, store.ErrConflict) {
			loser = r.owner
		} else {
			t.Fatal(r.err)
		}
	}
	if winner == "" || loser == "" {
		t.Fatalf("ownership race not fenced: winner %q, loser %q", winner, loser)
	}
	for _, id := range []string{"entry", "exit"} {
		var desired struct {
			Generation uint64 `json:"generation"`
			Owner      string `json:"owner"`
		}
		if err := second.Get("desired", id, &desired); err != nil || desired.Generation != 1 || desired.Owner != winner {
			t.Fatalf("desired %s = %+v, %v", id, desired, err)
		}
	}
	var attempt map[string]string
	if err := second.Get("ownership-attempts", winner, &attempt); err != nil || attempt["owner"] != winner {
		t.Fatalf("winning ownership missing: %v, %v", attempt, err)
	}
	if err := second.Get("ownership-attempts", loser, &attempt); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("losing ownership survived: %v", err)
	}
}

func TestComparedGenerationsRejectIncompleteOrDuplicateWrites(t *testing.T) {
	for _, problem := range []string{"duplicate requested ID", "missing generated record", "duplicate generated record", "duplicate associated record"} {
		t.Run(problem, func(t *testing.T) {
			s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{37}, 32))
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			ids := []string{"entry", "exit"}
			if problem == "duplicate requested ID" {
				ids = append(ids, "entry")
			}
			_, err = s.CompareSetsAndGenerateRecords("desired", ids, nil, nil, func(g map[string]uint64) ([]store.RecordWrite, error) {
				writes := []store.RecordWrite{
					{Kind: "desired", ID: "entry", Value: map[string]uint64{"generation": g["entry"]}},
					{Kind: "desired", ID: "exit", Value: map[string]uint64{"generation": g["exit"]}},
					{Kind: "manifest", ID: "batch", Value: g},
				}
				switch problem {
				case "missing generated record":
					writes = append(writes[:1], writes[2:]...)
				case "duplicate generated record":
					writes = append(writes, writes[0])
				case "duplicate associated record":
					writes = append(writes, writes[2])
				}
				return writes, nil
			})
			if err == nil {
				t.Fatal("invalid generation batch accepted")
			}
			for _, record := range [][2]string{{"desired", "entry"}, {"desired", "exit"}, {"manifest", "batch"}} {
				var value any
				if err := s.Get(record[0], record[1], &value); !errors.Is(err, store.ErrNotFound) {
					t.Fatalf("invalid batch exposed %s/%s: %v", record[0], record[1], err)
				}
			}
			for _, id := range []string{"entry", "exit"} {
				g, err := s.GenerateRecord("desired", id, func(g uint64) (any, error) {
					return map[string]uint64{"generation": g}, nil
				})
				if err != nil || g != 1 {
					t.Fatalf("invalid batch consumed %s generation: %d, %v", id, g, err)
				}
			}
		})
	}
}

func TestComparedGenerationsRollBackEveryCounterAndArtifactOnFailure(t *testing.T) {
	for _, failure := range []string{"callback", "associated write"} {
		t.Run(failure, func(t *testing.T) {
			s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{38}, 32))
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if _, err := s.GenerateRecord("desired", "entry", func(g uint64) (any, error) {
				return map[string]uint64{"generation": g}, nil
			}); err != nil {
				t.Fatal(err)
			}
			if err := s.Put("manifest", "batch", map[string]uint64{"entry": 1}); err != nil {
				t.Fatal(err)
			}
			build := func(g map[string]uint64) ([]store.RecordWrite, error) {
				return []store.RecordWrite{
					{Kind: "desired", ID: "entry", Value: map[string]uint64{"generation": g["entry"]}},
					{Kind: "desired", ID: "exit", Value: map[string]uint64{"generation": g["exit"]}},
					{Kind: "manifest", ID: "batch", Value: g},
					{Kind: "instance-owners", ID: "entry", Value: map[string]string{"deploymentId": "route"}},
					{Kind: "instance-owners", ID: "exit", Value: map[string]string{"deploymentId": "route"}},
				}, nil
			}
			callbackErr := errors.New("cannot build reviewed deployment")
			_, err = s.CompareSetsAndGenerateRecords("desired", []string{"entry", "exit"}, nil, nil, func(g map[string]uint64) ([]store.RecordWrite, error) {
				writes, _ := build(g)
				if failure == "callback" {
					return writes, callbackErr
				}
				return append(writes, store.RecordWrite{Kind: "attempt", ID: "bad", Value: make(chan int)}), nil
			})
			if err == nil || failure == "callback" && !errors.Is(err, callbackErr) {
				t.Fatalf("batch failure not returned: %v", err)
			}
			for _, record := range [][2]string{{"desired", "exit"}, {"instance-owners", "entry"}, {"instance-owners", "exit"}, {"attempt", "bad"}} {
				var value any
				if err := s.Get(record[0], record[1], &value); !errors.Is(err, store.ErrNotFound) {
					t.Fatalf("failed batch exposed %s/%s: %v", record[0], record[1], err)
				}
			}
			var desired, manifest map[string]uint64
			if err := s.Get("desired", "entry", &desired); err != nil || !reflect.DeepEqual(desired, map[string]uint64{"generation": 1}) {
				t.Fatalf("failed batch replaced existing desired: %v, %v", desired, err)
			}
			if err := s.Get("manifest", "batch", &manifest); err != nil || !reflect.DeepEqual(manifest, map[string]uint64{"entry": 1}) {
				t.Fatalf("failed batch replaced existing manifest: %v, %v", manifest, err)
			}
			generations, err := s.CompareSetsAndGenerateRecords("desired", []string{"entry", "exit"}, nil, nil, build)
			if err != nil || !reflect.DeepEqual(generations, map[string]uint64{"entry": 2, "exit": 1}) {
				t.Fatalf("failed batch consumed generations: %v, %v", generations, err)
			}
			manifest = nil
			if err := s.Get("manifest", "batch", &manifest); err != nil || !reflect.DeepEqual(manifest, map[string]uint64{"entry": 2, "exit": 1}) {
				t.Fatalf("successful batch lost manifest: %v, %v", manifest, err)
			}
		})
	}
}

func TestComparedGenerationsFenceSetMembershipBeforeBuilding(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{39}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Put("instances", "entry", map[string]string{"id": "entry"}); err != nil {
		t.Fatal(err)
	}
	_, err = s.CompareSetsAndGenerateRecords("desired", []string{"entry", "exit"}, nil, []store.RecordSetCompare{{Kind: "instances"}}, func(map[string]uint64) ([]store.RecordWrite, error) {
		t.Fatal("stale membership reached generation callback")
		return nil, nil
	})
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("changed set membership accepted: %v", err)
	}
	for _, id := range []string{"entry", "exit"} {
		g, err := s.GenerateRecord("desired", id, func(g uint64) (any, error) {
			return map[string]uint64{"generation": g}, nil
		})
		if err != nil || g != 1 {
			t.Fatalf("conflict consumed %s generation: %d, %v", id, g, err)
		}
	}
}

func TestComparedGenerationsCallbackCannotChangeAllocatedCounters(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	build := func(g map[string]uint64) ([]store.RecordWrite, error) {
		writes := []store.RecordWrite{
			{Kind: "desired", ID: "entry", Value: map[string]uint64{"generation": g["entry"]}},
			{Kind: "desired", ID: "exit", Value: map[string]uint64{"generation": g["exit"]}},
		}
		g["entry"] = 100
		delete(g, "exit")
		g["unrequested"] = 50
		return writes, nil
	}
	for _, want := range []map[string]uint64{{"entry": 1, "exit": 1}, {"entry": 2, "exit": 2}} {
		generations, err := s.CompareSetsAndGenerateRecords("desired", []string{"entry", "exit"}, nil, nil, build)
		if err != nil || !reflect.DeepEqual(generations, want) {
			t.Fatalf("callback changed allocated counters: %v, want %v, error %v", generations, want, err)
		}
		for _, id := range []string{"entry", "exit"} {
			var desired map[string]uint64
			if err := s.Get("desired", id, &desired); err != nil || desired["generation"] != want[id] {
				t.Fatalf("desired %s lost allocated generation: %v, %v", id, desired, err)
			}
		}
	}
}

func TestComparedGenerationsPreserveOwnershipAndCountersAcrossRestore(t *testing.T) {
	source, err := store.Open(filepath.Join(t.TempDir(), "source.db"), bytes.Repeat([]byte{40}, 32))
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	owner := map[string]string{"deploymentId": "route"}
	build := func(g map[string]uint64) ([]store.RecordWrite, error) {
		return []store.RecordWrite{
			{Kind: "agent-desired", ID: "entry", Value: map[string]uint64{"generation": g["entry"]}},
			{Kind: "agent-desired", ID: "exit", Value: map[string]uint64{"generation": g["exit"]}},
			{Kind: "instance-owners", ID: "entry", Value: owner},
			{Kind: "instance-owners", ID: "exit", Value: owner},
		}, nil
	}
	if _, err := source.CompareSetsAndGenerateRecords("agent-desired", []string{"entry", "exit"}, nil, nil, build); err != nil {
		t.Fatal(err)
	}
	snapshot, err := source.ExportSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "restored.db")
	key := bytes.Repeat([]byte{41}, 32)
	if err := store.RestoreFresh(context.Background(), path, key, snapshot); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	for _, id := range []string{"entry", "exit"} {
		var actual map[string]string
		if err := restored.Get("instance-owners", id, &actual); err != nil || !reflect.DeepEqual(actual, owner) {
			t.Fatalf("restored ownership for %s = %v, %v", id, actual, err)
		}
		var desired map[string]uint64
		if err := restored.Get("agent-desired", id, &desired); err != nil || desired["generation"] != 1 {
			t.Fatalf("restored desired for %s = %v, %v", id, desired, err)
		}
	}
	compares := []store.RecordCompare{{Kind: "instance-owners", ID: "entry", Expected: owner}, {Kind: "instance-owners", ID: "exit", Expected: owner}}
	generations, err := restored.CompareSetsAndGenerateRecords("agent-desired", []string{"entry", "exit"}, compares, nil, build)
	if err != nil || !reflect.DeepEqual(generations, map[string]uint64{"entry": 2, "exit": 2}) {
		t.Fatalf("restored batch lost generation fences: %v, %v", generations, err)
	}
}

func TestComparedGenerationCommitsManifestAndAttemptAtomically(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "db"), bytes.Repeat([]byte{35}, 32))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	build := func(g uint64) (any, []store.RecordWrite, error) {
		return map[string]uint64{"generation": g}, []store.RecordWrite{{Kind: "manifest", ID: "one", Value: map[string]uint64{"generation": g}}}, nil
	}
	compares := []store.RecordCompare{{Kind: "desired", ID: "core", Expected: nil}}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := s.CompareSetsAndGenerateRecord("desired", "core", compares, nil, build)
			results <- e
		}()
	}
	wg.Wait()
	close(results)
	success, conflicts := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if errors.Is(e, store.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("race not fenced: %d successes %d conflicts", success, conflicts)
	}
	var actual map[string]uint64
	if e = s.Get("manifest", "one", &actual); e != nil || actual["generation"] != 1 {
		t.Fatalf("manifest %v %v", actual, e)
	}
	_, e = s.CompareSetsAndGenerateRecord("desired", "core", nil, nil, func(g uint64) (any, []store.RecordWrite, error) {
		return map[string]uint64{"generation": g}, []store.RecordWrite{{Kind: "manifest", ID: "bad", Value: make(chan int)}}, nil
	})
	if e == nil {
		t.Fatal("invalid associated write accepted")
	}
	g, e := s.CompareSetsAndGenerateRecord("desired", "core", nil, nil, build)
	if e != nil || g != 2 {
		t.Fatalf("failed transaction consumed generation: %d %v", g, e)
	}
}
