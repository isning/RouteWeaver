package main

import "testing"

func TestNotificationColdBudgetConfiguration(t *testing.T) {
	b, err := notificationColdBudget(func(string) string { return "" })
	if err != nil || b.Rows != 1000000 || b.Bytes != 512<<20 {
		t.Fatalf("defaults %+v %v", b, err)
	}
	for _, bad := range []string{"0", "-1", "1000001", "bad"} {
		if _, err = notificationColdBudget(func(name string) string {
			if name == "ROUTEWEAVER_NOTIFICATION_COLD_ROWS" {
				return bad
			}
			return ""
		}); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	b, err = notificationColdBudget(func(name string) string {
		if name == "ROUTEWEAVER_NOTIFICATION_COLD_ROWS" {
			return "2"
		}
		return "4096"
	})
	if err != nil || b.Rows != 2 || b.Bytes != 4096 {
		t.Fatalf("custom %+v %v", b, err)
	}
}
