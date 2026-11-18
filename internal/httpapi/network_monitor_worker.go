package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"routeweaver/internal/domain"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
)

var networkCarriers = []struct {
	ID, Name string
	ASNs     []int
}{
	{"telecom", "中国电信", []int{4134, 4812, 4809, 23724, 141679}},
	{"unicom", "中国联通", []int{4837, 9929, 17621, 17816}},
	{"mobile", "中国移动", []int{9808, 56040, 56041, 56042, 56044, 56045, 56046, 56047, 56048, 24445}},
}

type globalpingLocation struct {
	Country string `json:"country"`
	City    string `json:"city"`
	ASN     int    `json:"asn"`
	Network string `json:"network"`
}
type globalpingProbe struct {
	Location globalpingLocation `json:"location"`
}
type globalpingResult struct {
	Probe  globalpingLocation `json:"probe"`
	Result struct {
		Status        string `json:"status"`
		FailureSource string `json:"failureSource"`
		Stats         *struct {
			Avg      *float64 `json:"avg"`
			Total    int      `json:"total"`
			Received int      `json:"rcv"`
			Loss     *float64 `json:"loss"`
		} `json:"stats"`
	} `json:"result"`
}
type globalpingMeasurement struct {
	ID      string             `json:"id"`
	Status  string             `json:"status"`
	Target  string             `json:"target"`
	Results []globalpingResult `json:"results"`
}
type globalpingClient struct {
	client       *http.Client
	base         string
	now          func() time.Time
	probes       []globalpingProbe
	cachedAt     time.Time
	blockedUntil time.Time
}

var errNetworkNotModified = errors.New("measurement not modified")

type networkProviderError struct {
	code  string
	until time.Time
}

func (e *networkProviderError) Error() string { return e.code }
func newGlobalpingClient() *globalpingClient {
	return &globalpingClient{client: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, base: "https://api.globalping.io/v1", now: time.Now}
}
func (g *globalpingClient) request(ctx context.Context, method, path string, body any, out any, etag ...string) (string, error) {
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	r, err := http.NewRequestWithContext(ctx, method, g.base+path, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	r.Header.Set("User-Agent", "RouteWeaver/0.2 (+connectivity-monitor)")
	r.Header.Set("Accept", "application/json")
	if len(etag) > 0 && etag[0] != "" {
		r.Header.Set("If-None-Match", etag[0])
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	res, err := g.client.Do(r)
	if err != nil {
		return "", &networkProviderError{code: "provider-unavailable"}
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotModified {
		return res.Header.Get("ETag"), errNetworkNotModified
	}
	if res.StatusCode == 429 {
		delay := time.Hour
		if seconds, e := strconv.Atoi(res.Header.Get("Retry-After")); e == nil && seconds > 0 {
			delay = time.Duration(seconds) * time.Second
		} else if at, e := http.ParseTime(res.Header.Get("Retry-After")); e == nil && at.After(g.now()) {
			delay = at.Sub(g.now())
		}
		g.blockedUntil = g.now().Add(delay)
		return "", &networkProviderError{code: "rate-limited", until: g.blockedUntil}
	}
	if res.StatusCode == 422 {
		return "", &networkProviderError{code: "provider-rejected"}
	}
	if res.StatusCode != 200 && res.StatusCode != 202 {
		return "", &networkProviderError{code: "provider-unavailable"}
	}
	limit := 2 << 20
	// The probe directory includes metadata for thousands of probes, unlike
	// the single-probe measurement responses.
	if method == http.MethodGet && path == "/probes" {
		limit = 16 << 20
	}
	payload, err := io.ReadAll(io.LimitReader(res.Body, int64(limit)+1))
	if err != nil || len(payload) > limit || json.Unmarshal(payload, out) != nil {
		return "", &networkProviderError{code: "invalid-response"}
	}
	return res.Header.Get("ETag"), nil
}
func (g *globalpingClient) available(ctx context.Context) ([]globalpingProbe, error) {
	if g.now().Before(g.blockedUntil) {
		return nil, &networkProviderError{code: "rate-limited", until: g.blockedUntil}
	}
	if !g.cachedAt.IsZero() && g.now().Sub(g.cachedAt) < 5*time.Minute {
		return g.probes, nil
	}
	var probes []globalpingProbe
	if _, err := g.request(ctx, "GET", "/probes", nil, &probes); err != nil {
		return nil, err
	}
	if len(probes) > 20000 {
		return nil, &networkProviderError{code: "invalid-response"}
	}
	g.probes = probes
	g.cachedAt = g.now()
	return probes, nil
}
func selectNetworkASN(probes []globalpingProbe, asns []int, city string) int {
	for _, asn := range asns {
		for _, p := range probes {
			if p.Location.Country == "CN" && p.Location.ASN == asn && (city == "" || strings.EqualFold(p.Location.City, city)) {
				return asn
			}
		}
	}
	return 0
}
func unknownNetworkResults(code string) []networkObservation {
	out := []networkObservation{}
	for _, c := range networkCarriers {
		out = append(out, networkObservation{Carrier: c.ID, Status: "unknown", Code: code})
	}
	return out
}
func providerCode(err error) string {
	var e *networkProviderError
	if errors.As(err, &e) {
		return e.code
	}
	return "provider-unavailable"
}
func (g *globalpingClient) measure(ctx context.Context, m networkMonitor, carrier string, asn int) networkObservation {
	return g.measureProbe(ctx, m, networkProbeSelection{ID: carrier, Country: "CN", City: m.ProbeCities[carrier], ASN: asn}, "")
}

func (g *globalpingClient) measureProbe(ctx context.Context, m networkMonitor, probe networkProbeSelection, pin string) networkObservation {
	carrier, asn := probe.ID, probe.ASN
	out := networkObservation{Carrier: carrier, Status: "unknown"}
	if asn == 0 {
		out.Code = "no-probe"
		return out
	}
	if g.now().Before(g.blockedUntil) {
		out.Code = "rate-limited"
		return out
	}
	options := map[string]any{"protocol": strings.ToUpper(m.Protocol), "packets": 3}
	if m.Protocol == "tcp" {
		options["port"] = m.Port
	}
	city := probe.City
	location := map[string]any{"country": probe.Country, "asn": asn, "limit": 1}
	if city != "" {
		location["city"] = city
	}
	if pin != "" {
		location = map[string]any{"magic": pin, "limit": 1}
	}
	body := map[string]any{"type": "ping", "target": m.Target, "timeout": 10, "measurementOptions": options, "locations": []any{location}}
	var created struct {
		ID string `json:"id"`
	}
	if _, err := g.request(ctx, "POST", "/measurements", body, &created); err != nil {
		out.Code = providerCode(err)
		if pin != "" && out.Code == "provider-rejected" {
			out.Code = "pinned-probe-unavailable"
		}
		return out
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(created.ID) {
		out.Code = "invalid-response"
		return out
	}
	out.MeasurementID = created.ID
	// Each GET completes before the next delay. Never replay the POST after an
	// uncertain result, and never poll faster than Globalping's two-per-second limit.
	etag := ""
	for attempts := 0; attempts < 20; attempts++ {
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			out.Code = "interrupted"
			return out
		case <-timer.C:
		}
		var result globalpingMeasurement
		nextETag, err := g.request(ctx, "GET", "/measurements/"+created.ID, nil, &result, etag)
		if errors.Is(err, errNetworkNotModified) {
			continue
		}
		if err != nil {
			out.Code = providerCode(err)
			return out
		}
		etag = nextETag
		if result.ID != created.ID || !strings.EqualFold(result.Target, m.Target) {
			out.Code = "invalid-response"
			return out
		}
		if result.Status == "in-progress" {
			continue
		}
		if pin != "" && result.Status == "finished" && len(result.Results) == 0 {
			out.Code = "pinned-probe-unavailable"
			return out
		}
		if result.Status != "finished" || len(result.Results) != 1 {
			out.Code = "invalid-response"
			return out
		}
		item := result.Results[0]
		if item.Probe.Country != probe.Country || item.Probe.ASN != asn || (city != "" && !strings.EqualFold(item.Probe.City, city)) {
			out.Code = "probe-mismatch"
			return out
		}
		if len(item.Probe.City) > 160 || len(item.Probe.Network) > 256 {
			out.Code = "invalid-response"
			return out
		}
		out.ASN = asn
		out.City = item.Probe.City
		out.Network = item.Probe.Network
		if item.Result.Status == "offline" {
			out.Code = "no-probe"
			return out
		}
		if item.Result.Status == "failed" {
			if item.Result.FailureSource == "target" {
				out.Status = "down"
				out.Code = "target-failed"
			} else {
				out.Code = "provider-unavailable"
			}
			return out
		}
		stats := item.Result.Stats
		if item.Result.Status != "finished" || stats == nil || stats.Total < 1 || stats.Received < 0 || stats.Received > stats.Total || stats.Loss == nil || math.IsNaN(*stats.Loss) || *stats.Loss < 0 || *stats.Loss > 100 {
			out.Code = "invalid-response"
			return out
		}
		out.Loss = stats.Loss
		if stats.Received == 0 {
			out.Status = "down"
			return out
		}
		if stats.Avg == nil || math.IsNaN(*stats.Avg) || math.IsInf(*stats.Avg, 0) || *stats.Avg < 0 {
			out.Code = "invalid-response"
			return out
		}
		out.Status = "up"
		out.LatencyMS = stats.Avg
		return out
	}
	out.Code = "provider-timeout"
	return out
}

type networkBudget struct {
	Reservations      []time.Time `json:"reservations"`
	ProbeReservations []time.Time `json:"probeReservations,omitempty"`
	BlockedUntil      time.Time   `json:"blockedUntil"`
}

func reserveNetworkBudget(s *store.Store, now time.Time, counts ...int) (time.Time, error) {
	count := len(networkCarriers)
	if len(counts) != 0 {
		count = counts[0]
	}
	var b networkBudget
	var previous any
	err := s.Get("network-monitor-budget", "globalping", &b)
	if err == nil {
		previous = b
	} else if !errors.Is(err, store.ErrNotFound) {
		return time.Time{}, err
	}
	if now.Before(b.BlockedUntil) {
		return b.BlockedUntil, nil
	}
	active := []time.Time{}
	cutoff := now.Add(-time.Hour)
	for _, t := range b.Reservations {
		if t.After(cutoff) {
			active = append(active, t, t, t)
		}
	}
	for _, t := range b.ProbeReservations {
		if t.After(cutoff) {
			active = append(active, t)
		}
	}
	sort.Slice(active, func(i, j int) bool { return active[i].Before(active[j]) })
	if excess := len(active) + count - 240; excess > 0 {
		return active[excess-1].Add(time.Hour), nil
	}
	b.Reservations = nil
	for i := 0; i < count; i++ {
		active = append(active, now)
	}
	b.ProbeReservations = active
	err = s.CompareAndPutRecords([]store.RecordCompare{{Kind: "network-monitor-budget", ID: "globalping", Expected: previous}}, []store.RecordWrite{{Kind: "network-monitor-budget", ID: "globalping", Value: b}})
	return time.Time{}, err
}
func blockNetworkBudget(s *store.Store, until time.Time) error {
	var b networkBudget
	if err := s.Get("network-monitor-budget", "globalping", &b); err != nil {
		return err
	}
	previous := b
	if !until.After(b.BlockedUntil) {
		return nil
	}
	b.BlockedUntil = until
	return s.CompareAndPutRecords([]store.RecordCompare{{Kind: "network-monitor-budget", ID: "globalping", Expected: previous}}, []store.RecordWrite{{Kind: "network-monitor-budget", ID: "globalping", Value: b}})
}
func publicMonitorTarget(ctx context.Context, target string) bool {
	if !validNetworkTarget(target) {
		return false
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", target)
	if err != nil || len(ips) == 0 {
		return false
	}
	for _, ip := range ips {
		ip = ip.Unmap()
		if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || netip.MustParsePrefix("100.64.0.0/10").Contains(ip) {
			return false
		}
	}
	return true
}

// RunNetworkMonitors executes only explicitly saved, enabled schedules or queued
// manual checks. The shared durable reservation caps us at 240 probe tests/hour.
func RunNetworkMonitors(ctx context.Context, s *store.Store) {
	client := newGlobalpingClient()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if err := runNetworkMonitorBatch(ctx, s, client, time.Now().UTC()); err != nil && ctx.Err() == nil {
			log.Print("Connectivity monitor processing failed; pending work will be reconciled")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func runNetworkMonitorBatch(ctx context.Context, s *store.Store, g *globalpingClient, now time.Time) error {
	records, err := s.List(networkMonitorKind)
	if err != nil {
		return err
	}
	monitors := []networkMonitor{}
	for _, raw := range records {
		var m networkMonitor
		if json.Unmarshal(raw, &m) == nil {
			monitors = append(monitors, m)
		}
	}
	sort.SliceStable(monitors, func(i, j int) bool {
		a, b := monitors[i].NextCheckAt, monitors[j].NextCheckAt
		if a == nil {
			return b != nil
		}
		return b != nil && a.Before(*b)
	})
	for _, m := range monitors {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if len(m.PendingAlerts) > 0 {
			if err := flushNetworkAlerts(s, m); err != nil {
				return err
			}
			continue
		}
		if m.StartedAt != nil {
			if now.Sub(*m.StartedAt) < 3*time.Minute {
				continue
			}
			previous := m
			m.StartedAt = nil
			m.Queued = false
			m.ErrorCode = "interrupted"
			next := now.Add(time.Duration(m.IntervalMinutes) * time.Minute)
			m.NextCheckAt = &next
			m.Revision++
			if err := s.CompareAndPutRecords([]store.RecordCompare{{Kind: networkMonitorKind, ID: m.HostID, Expected: previous}}, []store.RecordWrite{{Kind: networkMonitorKind, ID: m.HostID, Value: m}}); err != nil {
				return err
			}
			continue
		}
		if !m.Queued && (!m.Enabled || m.NextCheckAt == nil || m.NextCheckAt.After(now)) {
			continue
		}
		var host domain.Host
		if err := s.Get("hosts", m.HostID, &host); err != nil {
			continue
		}
		previous := m
		if monitorTarget(host, m.MonitorIP) != m.Target {
			m.Enabled = false
			m.Queued = false
			m.ErrorCode = "target-changed"
			m.NextCheckAt = nil
			m.Revision++
			if err := saveNetworkMonitor(s, host, previous, m); err != nil {
				return err
			}
			continue
		}
		if !g.blockedUntil.IsZero() && now.Before(g.blockedUntil) {
			next := g.blockedUntil
			m.NextCheckAt = &next
			m.Queued = false
			m.ErrorCode = "rate-limited"
			m.Revision++
			if err := saveNetworkMonitor(s, host, previous, m); err != nil {
				return err
			}
			continue
		}
		probeCount := len(m.Probes)
		if probeCount == 0 {
			probeCount = len(networkCarriers)
		}
		until, err := reserveNetworkBudget(s, now, probeCount)
		if err != nil {
			return err
		}
		if !until.IsZero() {
			m.NextCheckAt = &until
			m.Queued = false
			m.ErrorCode = "budget-exhausted"
			m.Revision++
			if err := saveNetworkMonitor(s, host, previous, m); err != nil {
				return err
			}
			continue
		}
		m.StartedAt = &now
		m.Queued = false
		m.LastRequestedAt = &now
		m.Revision++
		if err := saveNetworkMonitor(s, host, previous, m); err != nil {
			return err
		}
		var claimed networkMonitor
		// Freeze the pre-result maps and slices: CAS compares the claimed record.
		snapshot, err := json.Marshal(m)
		if err != nil {
			return err
		}
		if err = json.Unmarshal(snapshot, &claimed); err != nil {
			return err
		}
		checkCtx, cancel := context.WithTimeout(ctx, 100*time.Second)
		results := make([]networkObservation, 0, probeCount)
		if len(m.Probes) != 0 {
			reachable := publicMonitorTarget(checkCtx, m.Target)
			if m.ProbePins == nil {
				m.ProbePins = make(map[string]string)
			}
			for _, probe := range m.Probes {
				if !reachable {
					results = append(results, networkObservation{Carrier: probe.ID, Status: "unknown", Code: "invalid-target"})
					continue
				}
				probeCtx, stop := context.WithTimeout(checkCtx, 12*time.Second)
				observation := g.measureProbe(probeCtx, m, probe, m.ProbePins[probe.ID])
				if probeCtx.Err() == context.DeadlineExceeded && observation.Status == "unknown" {
					observation.Code = "provider-timeout"
				}
				stop()
				if observation.Status == "up" || observation.Status == "down" {
					m.ProbePins[probe.ID] = observation.MeasurementID
				}
				results = append(results, observation)
			}
		} else {
			results = unknownNetworkResults("invalid-target")
			if publicMonitorTarget(checkCtx, m.Target) {
				probes, e := g.available(checkCtx)
				if e != nil {
					results = unknownNetworkResults(providerCode(e))
				} else {
					results = nil
					for _, carrier := range networkCarriers {
						results = append(results, g.measure(checkCtx, m, carrier.ID, selectNetworkASN(probes, carrier.ASNs, m.ProbeCities[carrier.ID])))
					}
				}
			}
		}
		if checkCtx.Err() != nil {
			code := "provider-timeout"
			if ctx.Err() != nil {
				code = "interrupted"
			}
			for i := range results {
				if results[i].Status == "unknown" && results[i].Code != "no-probe" {
					results[i].Code = code
				}
			}
		}
		cancel()
		if g.now().Before(g.blockedUntil) {
			if err := blockNetworkBudget(s, g.blockedUntil); err != nil {
				return err
			}
		}
		finished := g.now().UTC()
		round := networkRound{At: finished, Target: m.Target, Protocol: m.Protocol, Port: m.Port, Results: results}
		m.History = append(m.History, round)
		if len(m.History) > networkHistoryLimit {
			m.History = append([]networkRound(nil), m.History[len(m.History)-networkHistoryLimit:]...)
		}
		m.StartedAt = nil
		m.ErrorCode = ""
		next := finished.Add(time.Duration(m.IntervalMinutes) * time.Minute)
		m.NextCheckAt = &next
		if finished.Before(g.blockedUntil) {
			m.ErrorCode = "rate-limited"
			m.NextCheckAt = &g.blockedUntil
		}
		updateNetworkIncidents(&m, host, round)
		m.Revision++
		if err := saveNetworkMonitor(s, host, claimed, m); err != nil {
			return err
		}
		if err := flushNetworkAlerts(s, m); err != nil {
			return err
		}
		return nil // One bounded check per tick; process schedules in due-time order.
	}
	return nil
}
func updateNetworkIncidents(m *networkMonitor, host domain.Host, round networkRound) {
	if m.Failures == nil {
		m.Failures = map[string]int{}
	}
	if m.Incidents == nil {
		m.Incidents = map[string]bool{}
	}
	for _, o := range round.Results {
		recovery := false
		alert := false
		switch o.Status {
		case "down":
			m.Failures[o.Carrier]++
			if m.Failures[o.Carrier] >= 3 && !m.Incidents[o.Carrier] {
				m.Incidents[o.Carrier] = true
				alert = true
			}
		case "up":
			m.Failures[o.Carrier] = 0
			if m.Incidents[o.Carrier] {
				m.Incidents[o.Carrier] = false
				recovery = true
			}
		default:
			m.Failures[o.Carrier] = 0
		}
		if (!alert && !recovery) || !m.Notify {
			continue
		}
		name := o.Carrier
		for _, c := range networkCarriers {
			if c.ID == o.Carrier {
				name = c.Name
				if label := networkProbeCities[m.ProbeCities[c.ID]]; label != "" {
					name = label + strings.TrimPrefix(name, "中国")
				}
			}
		}
		for _, probe := range m.Probes {
			if probe.ID == o.Carrier {
				name = probe.Name
				break
			}
		}
		state := "连续三次未连通"
		if recovery {
			state = "已恢复连通"
		}
		title := fmt.Sprintf("%s：%s%s", host.Name, name, state)
		digest := sha256.Sum256([]byte(fmt.Sprintf("%s/%s/%s/%s/%d/%t", host.ID, round.At.Format(time.RFC3339Nano), o.Carrier, m.Target, m.Port, recovery)))
		method := strings.ToUpper(m.Protocol)
		if m.Protocol == "tcp" {
			method += fmt.Sprintf(" 端口 %d", m.Port)
		}
		m.PendingAlerts = append(m.PendingAlerts, notifications.Event{EventID: "network-" + hex.EncodeToString(digest[:]), Kind: "network-monitor", Title: title, Body: fmt.Sprintf("%s → %s，%s 检测。结果代表该公共探针的观测。", name, m.Target, method), CreatedAt: round.At, AdminOnly: true})
	}
}
func flushNetworkAlerts(s *store.Store, m networkMonitor) error {
	if len(m.PendingAlerts) == 0 {
		return nil
	}
	ids := []string{}
	for _, event := range m.PendingAlerts {
		ids = append(ids, event.EventID)
	}
	if err := s.UpdateNotificationsScope(notifications.Scope{EventIDs: ids}, func(st *notifications.State) error {
		if !st.Settings.InApp {
			return nil
		}
		for _, event := range m.PendingAlerts {
			if _, ok := st.Events[event.EventID]; ok {
				continue
			}
			st.Events[event.EventID] = event
			st.Deliveries[event.EventID+"/in-app"] = notifications.Delivery{EventID: event.EventID, Channel: "in-app", Status: "available", CreatedAt: event.CreatedAt, SettingsRevision: st.Settings.Revision}
		}
		return nil
	}); err != nil {
		return err
	}
	previous := m
	m.PendingAlerts = nil
	m.Revision++
	return s.CompareAndPutRecords([]store.RecordCompare{{Kind: networkMonitorKind, ID: m.HostID, Expected: previous}}, []store.RecordWrite{{Kind: networkMonitorKind, ID: m.HostID, Value: m}})
}
