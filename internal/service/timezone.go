package service

import (
	"time"
	_ "time/tzdata"
)

// DisplayLocation does not change the explicit timezone of an existing quota cycle.
func DisplayLocation(name string) (*time.Location, error) {
	if name == "" || name == "UTC+8" {
		return DefaultLocation, nil
	}
	return time.LoadLocation(name)
}
