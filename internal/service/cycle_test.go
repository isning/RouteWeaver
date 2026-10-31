package service_test

import (
	"routeweaver/internal/service"
	"testing"
	"time"
)

func at(s string) time.Time { v, _ := time.Parse(time.RFC3339, s); return v }
func TestCalendarClampingRestoresDay(t *testing.T) {
	p := service.CyclePolicy{Mode: "anniversary", Anchor: at("2024-01-31T00:00:00+08:00")}
	for _, tt := range []struct{ now, want string }{{"2024-02-15T00:00:00+08:00", "2024-02-29T00:00:00+08:00"}, {"2024-03-01T00:00:00+08:00", "2024-03-31T00:00:00+08:00"}, {"2025-02-01T00:00:00+08:00", "2025-02-28T00:00:00+08:00"}} {
		w, e := p.Window(at(tt.now))
		if e != nil || w.NextReset.Format(time.RFC3339) != tt.want {
			t.Fatalf("%+v %v", w, e)
		}
	}
}
func TestWeightedUsesIntegerCeiling(t *testing.T) {
	n, e := service.WeightedBytes(3, 1500000)
	if e != nil || n != 5 {
		t.Fatalf("%d %v", n, e)
	}
	if _, e = service.WeightedBytes(1<<62, 10000000); e == nil {
		t.Fatal("overflow accepted")
	}
}
