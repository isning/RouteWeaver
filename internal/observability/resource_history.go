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
	Hourly []ResourcePoint `json:"hourly,omitempty"`
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

func prunePoints(input []ResourcePoint, now time.Time, retention time.Duration, limit int) []ResourcePoint {
	points := make([]ResourcePoint, 0, len(input))
	for _, p := range input {
		if p.ObservedAt.After(now.Add(-retention)) && !p.ObservedAt.After(now.Add(time.Minute)) {
			points = append(points, p)
		}
	}
	if len(points) > limit {
		points = points[len(points)-limit:]
	}
	return points
}
func PruneResourceHistory(h ResourceHistory, now time.Time) ResourceHistory {
	return ResourceHistory{Points: prunePoints(h.Points, now, ResourceHistoryRetention, ResourceHistoryPoints), Hourly: prunePoints(h.Hourly, now, 7*24*time.Hour, 168)}
}
func AppendResourceHistory(h ResourceHistory, s Snapshot, now time.Time) (ResourceHistory, bool) {
	fine, fineChanged := appendPoints(h.Points, s, now, ResourceHistoryInterval, ResourceHistoryRetention, ResourceHistoryPoints)
	hourly, hourlyChanged := appendPoints(h.Hourly, s, now, time.Hour, 7*24*time.Hour, 168)
	return ResourceHistory{Points: fine, Hourly: hourly}, fineChanged || hourlyChanged
}
func appendPoints(points []ResourcePoint, s Snapshot, now time.Time, interval, retention time.Duration, limit int) ([]ResourcePoint, bool) {
	h := ResourceHistory{Points: points}
	// First real observation of each bucket. Exceptions persist discontinuities,
	// so an intervening restart cannot disappear behind downsampling.
	if len(h.Points) > 0 {
		last := h.Points[len(h.Points)-1]
		if !s.ObservedAt.After(last.ObservedAt) {
			return h.Points, false
		}
		if (s.Continuity == "continuous" || last.BreakBefore) && s.ObservedAt.Truncate(interval).Equal(last.ObservedAt.Truncate(interval)) {
			return h.Points, false
		}
	}
	h.Points = prunePoints(h.Points, now, retention, limit)
	p := ResourcePoint{ObservedAt: s.ObservedAt, CPUPercent: s.CPUPercent, ReceiveBytesPerSecond: s.ReceiveBytesPerSecond, TransmitBytesPerSecond: s.TransmitBytesPerSecond, BreakBefore: s.Continuity != "continuous"}
	if s.Metrics.MemoryTotalBytes > 0 {
		p.MemoryUsedPercent = 100 * (1 - float64(s.Metrics.MemoryAvailableBytes)/float64(s.Metrics.MemoryTotalBytes))
	}
	if len(h.Points) > 0 {
		last := h.Points[len(h.Points)-1]
		if s.ObservedAt.Sub(last.ObservedAt) > max(FreshFor, interval*3/2) {
			p.BreakBefore = true
		}
		if s.ObservedAt.Truncate(interval).Equal(last.ObservedAt.Truncate(interval)) {
			h.Points = h.Points[:len(h.Points)-1]
		}
	}
	h.Points = append(h.Points, p)
	if len(h.Points) > limit {
		h.Points = h.Points[len(h.Points)-limit:]
	}
	return h.Points, true
}
