package main

import (
	"fmt"
	"routeweaver/internal/store"
	"strconv"
)

func notificationColdBudget(lookup func(string) string) (store.NotificationColdBudget, error) {
	b := store.DefaultNotificationColdBudget()
	for name, target := range map[string]*int64{"ROUTEWEAVER_NOTIFICATION_COLD_ROWS": &b.Rows, "ROUTEWEAVER_NOTIFICATION_COLD_BYTES": &b.Bytes} {
		if raw := lookup(name); raw != "" {
			v, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				return b, fmt.Errorf("%s must be a positive decimal integer", name)
			}
			*target = v
		}
	}
	return b, b.Validate()
}
