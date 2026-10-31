package httpapi

import (
	"fmt"
	"routeweaver/internal/domain"
	"strings"
	"unicode"
)

func validateHostLabels(host domain.Host) error {
	valid := func(label string) bool {
		return len(label) <= 64 && strings.TrimSpace(label) == label && strings.IndexFunc(label, unicode.IsControl) < 0
	}
	if !valid(host.Group) || len(host.Tags) > 32 {
		return fmt.Errorf("group labels are at most 64 bytes; at most 32 tags allowed")
	}
	seen := map[string]bool{}
	for _, tag := range host.Tags {
		if tag == "" || !valid(tag) || seen[tag] {
			return fmt.Errorf("tags must be unique nonempty labels of at most 64 bytes")
		}
		seen[tag] = true
	}
	return nil
}
