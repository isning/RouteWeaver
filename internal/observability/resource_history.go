package observability

import "time"

const ResourceHistoryInterval = 5 * time.Minute
const ResourceHistoryRetention = 24 * time.Hour
const ResourceHistoryPoints = 288

// ResourcePoint is an actual snapshot, not a bucket average, peak, or billing
// estimate. Missing derivatives stay nil; BreakBefore prevents interpolation
// across restarts, dropped observations and source/configuration changes.
type ResourcePoint struct {
	ObservedAt             time.Time `json:"observedAt"`
	CPUPercent             *float64  `json:"cpuPercent"`
	MemoryUsedPercent      float64   `json:"memoryUsedPercent"`
	ReceiveBytesPerSecond  *float64  `json:"receiveBytesPerSecond"`
	TransmitBytesPerSecond *float64  `json:"transmitBytesPerSecond"`
	BreakBefore            bool      `json:"breakBefore"`
}
type ResourceHistory struct {
	Points []ResourcePoint `json:"points"`
}
type ResourceHistoryView struct {
	NodeID          string          `json:"nodeId"`
	Available       bool            `json:"available"`
	Reason          string          `json:"reason,omitempty"`
	IntervalSeconds int             `json:"intervalSeconds"`
	WindowStart     time.Time       `json:"windowStart"`
	WindowEnd       time.Time       `json:"windowEnd"`
	Points          []ResourcePoint `json:"points"`
}

func PruneResourceHistory(h ResourceHistory, now time.Time) ResourceHistory {
	points := make([]ResourcePoint, 0, len(h.Points))
	for _, p := range h.Points {
		if p.ObservedAt.After(now.Add(-ResourceHistoryRetention)) && !p.ObservedAt.After(now.Add(time.Minute)) {
			points = append(points, p)
		}
	}
	if len(points) > ResourceHistoryPoints {
		points = points[len(points)-ResourceHistoryPoints:]
	}
	return ResourceHistory{Points: points}
}
func AppendResourceHistory(h ResourceHistory, s Snapshot, now time.Time) (ResourceHistory, bool) {
	// First real observation of each bucket. Exceptions persist discontinuities,
	// so an intervening restart cannot disappear behind downsampling.
	if len(h.Points) > 0 {
		last := h.Points[len(h.Points)-1]
		if !s.ObservedAt.After(last.ObservedAt) {
			return h, false
		}
		if (s.Continuity == "continuous" || last.BreakBefore) && s.ObservedAt.Truncate(ResourceHistoryInterval).Equal(last.ObservedAt.Truncate(ResourceHistoryInterval)) {
			return h, false
		}
	}
	h = PruneResourceHistory(h, now)
	p := ResourcePoint{ObservedAt: s.ObservedAt, CPUPercent: s.CPUPercent, ReceiveBytesPerSecond: s.ReceiveBytesPerSecond, TransmitBytesPerSecond: s.TransmitBytesPerSecond, BreakBefore: s.Continuity != "continuous"}
	if s.Metrics.MemoryTotalBytes > 0 {
		p.MemoryUsedPercent = 100 * (1 - float64(s.Metrics.MemoryAvailableBytes)/float64(s.Metrics.MemoryTotalBytes))
	}
	if len(h.Points) > 0 {
		last := h.Points[len(h.Points)-1]
		if s.ObservedAt.Sub(last.ObservedAt) > FreshFor {
			p.BreakBefore = true
		}
		if s.ObservedAt.Truncate(ResourceHistoryInterval).Equal(last.ObservedAt.Truncate(ResourceHistoryInterval)) {
			h.Points = h.Points[:len(h.Points)-1]
		}
	}
	h.Points = append(h.Points, p)
	if len(h.Points) > ResourceHistoryPoints {
		h.Points = h.Points[len(h.Points)-ResourceHistoryPoints:]
	}
	return h, true
}
