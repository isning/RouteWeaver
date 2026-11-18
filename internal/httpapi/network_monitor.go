package httpapi

import (
	"errors"
	"maps"
	"net/http"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"routeweaver/internal/domain"
	"routeweaver/internal/notifications"
	"routeweaver/internal/store"
)

const networkMonitorKind = "network-monitors"
const networkHistoryLimit = 288

type networkObservation struct {
	Carrier       string   `json:"carrier"`
	Status        string   `json:"status"`
	City          string   `json:"city,omitempty"`
	Network       string   `json:"network,omitempty"`
	ASN           int      `json:"asn,omitempty"`
	LatencyMS     *float64 `json:"latencyMs,omitempty"`
	Loss          *float64 `json:"loss,omitempty"`
	Code          string   `json:"code,omitempty"`
	MeasurementID string   `json:"measurementId,omitempty"`
}
type networkRound struct {
	At       time.Time            `json:"at"`
	Target   string               `json:"target"`
	Protocol string               `json:"protocol"`
	Port     int                  `json:"port"`
	Results  []networkObservation `json:"results"`
}

var networkProbeCities = map[string]string{
	"Beijing": "北京", "Shanghai": "上海", "Guangzhou": "广州",
	"Shenzhen": "深圳", "Hangzhou": "杭州", "Nanjing": "南京",
	"Wuhan": "武汉", "Chengdu": "成都", "Changsha": "长沙",
	"Zhengzhou": "郑州", "Fuzhou": "福州", "Xi'an": "西安",
}

const maxMonitorProbes = 8

type networkProbeSelection struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Country string `json:"country"`
	City    string `json:"city"`
	ASN     int    `json:"asn"`
}

var monitorCountryPattern = regexp.MustCompile(`^[A-Z]{2}$`)

func validMonitorProbes(probes []networkProbeSelection) bool {
	if len(probes) < 1 || len(probes) > maxMonitorProbes {
		return false
	}
	ids := make(map[string]bool, len(probes))
	for _, probe := range probes {
		if !domain.ValidID(probe.ID) || ids[probe.ID] || strings.TrimSpace(probe.Name) == "" || len(probe.Name) > 100 || strings.TrimSpace(probe.City) == "" || len(probe.City) > 100 || !monitorCountryPattern.MatchString(probe.Country) || probe.ASN <= 0 || int64(probe.ASN) > 4294967295 {
			return false
		}
		ids[probe.ID] = true
	}
	return true
}

func retainProbeValues[T any](values map[string]T, retained map[string]bool) map[string]T {
	result := make(map[string]T)
	for id, value := range values {
		if retained[id] {
			result[id] = value
		}
	}
	return result
}

type networkMonitor struct {
	Probes        []networkProbeSelection `json:"probes,omitempty"`
	ProbePins     map[string]string       `json:"probePins,omitempty"`
	ProbeCities   map[string]string       `json:"probeCities,omitempty"`
	MonitorIP     string                  `json:"monitorIp,omitempty"`
	Notify        bool                    `json:"notify"`
	Failures      map[string]int          `json:"failures,omitempty"`
	Incidents     map[string]bool         `json:"incidents,omitempty"`
	PendingAlerts []notifications.Event   `json:"pendingAlerts,omitempty"`

	HostID          string         `json:"hostId"`
	Revision        uint64         `json:"revision"`
	Enabled         bool           `json:"enabled"`
	IntervalMinutes int            `json:"intervalMinutes"`
	Protocol        string         `json:"protocol"`
	Port            int            `json:"port"`
	Target          string         `json:"target"`
	Queued          bool           `json:"queued"`
	StartedAt       *time.Time     `json:"startedAt,omitempty"`
	NextCheckAt     *time.Time     `json:"nextCheckAt,omitempty"`
	LastRequestedAt *time.Time     `json:"lastRequestedAt,omitempty"`
	ErrorCode       string         `json:"errorCode,omitempty"`
	History         []networkRound `json:"history"`
}
type networkMonitorView struct {
	networkMonitor
	CurrentTarget  string `json:"currentTarget"`
	RequiresReview bool   `json:"requiresReview"`
}

func readNetworkMonitor(s *store.Store, host domain.Host) (networkMonitor, any, error) {
	var m networkMonitor
	err := s.Get(networkMonitorKind, host.ID, &m)
	if errors.Is(err, store.ErrNotFound) {
		return networkMonitor{HostID: host.ID, Target: host.Address, Notify: true, IntervalMinutes: 5, Protocol: "tcp", Port: 443, History: []networkRound{}}, nil, nil
	}
	return m, m, err
}
func monitorTarget(host domain.Host, ip string) string {
	if ip != "" {
		return ip
	}
	return host.Address
}

func networkView(m networkMonitor, host domain.Host) networkMonitorView {
	if m.History == nil {
		m.History = []networkRound{}
	}
	m.PendingAlerts = nil
	m.ProbePins = nil
	return networkMonitorView{networkMonitor: m, CurrentTarget: monitorTarget(host, m.MonitorIP), RequiresReview: m.Revision > 0 && m.Target != monitorTarget(host, m.MonitorIP)}
}
func validNetworkTarget(target string) bool {
	if target == "" || len(target) > 253 || strings.ContainsAny(target, "/@?#%\\: \t\r\n") {
		// A bare IPv6 address is also valid; URL and host:port input are not.
		ip, err := netip.ParseAddr(target)
		ip = ip.Unmap()
		return err == nil && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast()
	}
	if ip, err := netip.ParseAddr(target); err == nil {
		ip = ip.Unmap()
		return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast()
	}
	if !strings.Contains(target, ".") || strings.HasSuffix(strings.ToLower(target), ".local") || strings.HasSuffix(strings.ToLower(target), ".localhost") {
		return false
	}
	for _, label := range strings.Split(strings.TrimSuffix(target, "."), ".") {
		if len(label) < 1 || len(label) > 63 || !regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$`).MatchString(label) {
			return false
		}
	}
	return true
}
func saveNetworkMonitor(s *store.Store, host domain.Host, previous any, m networkMonitor) error {
	return s.CompareAndPutRecords([]store.RecordCompare{{Kind: "hosts", ID: host.ID, Expected: host}, {Kind: networkMonitorKind, ID: host.ID, Expected: previous}}, []store.RecordWrite{{Kind: networkMonitorKind, ID: host.ID, Value: m}})
}
func (h *server) registerNetworkMonitors(r chi.Router) {
	const path = "/admin/hosts/{hostID}/network-monitor"
	hostFor := func(w http.ResponseWriter, r *http.Request) (domain.Host, bool) {
		var host domain.Host
		if err := h.s.Get("hosts", chi.URLParam(r, "hostID"), &host); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				fail(w, 404, "server not found")
			} else {
				fail(w, 500, "cannot read server")
			}
			return host, false
		}
		return host, true
	}
	r.Get(path, func(w http.ResponseWriter, r *http.Request) {
		host, ok := hostFor(w, r)
		if !ok {
			return
		}
		m, _, err := readNetworkMonitor(h.s, host)
		if err != nil {
			fail(w, 500, "cannot read network monitor")
			return
		}
		writeJSON(w, 200, networkView(m, host))
	})
	r.Put(path, func(w http.ResponseWriter, r *http.Request) {
		host, ok := hostFor(w, r)
		if !ok {
			return
		}
		var in struct {
			MonitorIP        string                   `json:"monitorIp"`
			Notify           bool                     `json:"notify"`
			ExpectedRevision uint64                   `json:"expectedRevision"`
			ProbeCities      map[string]string        `json:"probeCities"`
			Probes           *[]networkProbeSelection `json:"probes"`
			Enabled          bool                     `json:"enabled"`
			IntervalMinutes  int                      `json:"intervalMinutes"`
			Protocol         string                   `json:"protocol"`
			Port             int                      `json:"port"`
		}
		if !decode(w, r, &in) {
			return
		}
		if (in.IntervalMinutes != 1 && in.IntervalMinutes != 5 && in.IntervalMinutes != 10 && in.IntervalMinutes != 15 && in.IntervalMinutes != 30 && in.IntervalMinutes != 60) || (in.Protocol != "tcp" && in.Protocol != "icmp") || in.Port < 1 || in.Port > 65535 {
			fail(w, 400, "invalid monitor settings")
			return
		}
		ip := strings.TrimSpace(in.MonitorIP)
		if ip != "" {
			addr, err := netip.ParseAddr(ip)
			if err != nil || addr.Zone() != "" || !validNetworkTarget(ip) || netip.MustParsePrefix("100.64.0.0/10").Contains(addr.Unmap()) {
				fail(w, 400, "请输入可由公网探针访问的 IPv4 或 IPv6 地址")
				return
			}
		}
		target := monitorTarget(host, ip)
		if !validNetworkTarget(target) {
			fail(w, 400, "请填写监控 IP，或使用可由公网探针访问的服务器地址")
			return
		}
		m, previous, err := readNetworkMonitor(h.s, host)
		if err != nil {
			fail(w, 500, "cannot read network monitor")
			return
		}
		if in.ExpectedRevision != m.Revision || m.Queued || m.StartedAt != nil {
			fail(w, 409, "monitor changed or a check is pending")
			return
		}
		cities := m.ProbeCities
		if in.ProbeCities != nil {
			cities = make(map[string]string, len(networkCarriers))
			for id, city := range in.ProbeCities {
				validCarrier := false
				for _, carrier := range networkCarriers {
					if carrier.ID == id {
						validCarrier = true
						break
					}
				}
				if !validCarrier || (city != "" && networkProbeCities[city] == "") {
					fail(w, 400, "请选择有效的运营商探针城市")
					return
				}
				if city != "" {
					cities[id] = city
				}
			}
		}
		probes := m.Probes
		if in.Probes != nil {
			probes = *in.Probes
			if !validMonitorProbes(probes) {
				fail(w, 400, "请填写 1–8 个探针的名称、国家代码、城市和 ASN")
				return
			}
		}
		probesChanged := !slices.Equal(m.Probes, probes)
		if probesChanged {
			retained := make(map[string]bool, len(probes))
			pins := make(map[string]string, len(probes))
			for _, probe := range probes {
				for _, old := range m.Probes {
					if old.ID == probe.ID && old.Country == probe.Country && old.City == probe.City && old.ASN == probe.ASN {
						retained[probe.ID] = true
						if pin := m.ProbePins[probe.ID]; pin != "" {
							pins[probe.ID] = pin
						}
					}
				}
			}
			m.ProbePins = pins
			history := make([]networkRound, 0, len(m.History))
			for _, round := range m.History {
				observations := make([]networkObservation, 0, len(round.Results))
				for _, result := range round.Results {
					if retained[result.Carrier] {
						observations = append(observations, result)
					}
				}
				if len(observations) > 0 {
					round.Results = observations
					history = append(history, round)
				}
			}
			m.History = history
			m.Failures = retainProbeValues(m.Failures, retained)
			m.Incidents = retainProbeValues(m.Incidents, retained)
		}
		if m.Target != target || m.Protocol != in.Protocol || m.Port != in.Port || (len(probes) == 0 && !maps.Equal(m.ProbeCities, cities)) {
			m.History = []networkRound{}
			m.Failures = nil
			m.Incidents = nil
		}
		m.Revision++
		m.ProbeCities = cities
		m.Probes = probes
		m.Target = target
		m.MonitorIP = ip
		m.Enabled = in.Enabled
		m.Notify = in.Notify
		m.IntervalMinutes = in.IntervalMinutes
		m.Protocol = in.Protocol
		m.Port = in.Port
		m.ErrorCode = ""
		m.NextCheckAt = nil
		if m.Enabled {
			now := time.Now().UTC()
			m.NextCheckAt = &now
		}
		if err = saveNetworkMonitor(h.s, host, previous, m); err != nil {
			storeError(w, err)
			return
		}
		h.s.Audit(current(r).Account.ID, "network-monitor.updated", host.ID)
		writeJSON(w, 200, networkView(m, host))
	})
	r.Post(path+"/check", func(w http.ResponseWriter, r *http.Request) {
		host, ok := hostFor(w, r)
		if !ok {
			return
		}
		var in struct {
			ExpectedRevision uint64 `json:"expectedRevision"`
		}
		if !decode(w, r, &in) {
			return
		}
		m, previous, err := readNetworkMonitor(h.s, host)
		if err != nil {
			fail(w, 500, "cannot read network monitor")
			return
		}
		if m.Revision == 0 || in.ExpectedRevision != m.Revision || m.Target != monitorTarget(host, m.MonitorIP) || m.Queued || m.StartedAt != nil {
			fail(w, 409, "save current monitor settings before checking")
			return
		}
		now := time.Now().UTC()
		if m.LastRequestedAt != nil && now.Sub(*m.LastRequestedAt) < time.Minute {
			w.Header().Set("Retry-After", "60")
			fail(w, 429, "wait one minute before another check")
			return
		}
		m.Queued = true
		m.LastRequestedAt = &now
		m.Revision++
		if err = saveNetworkMonitor(h.s, host, previous, m); err != nil {
			storeError(w, err)
			return
		}
		h.s.Audit(current(r).Account.ID, "network-monitor.check-requested", host.ID)
		writeJSON(w, 202, networkView(m, host))
	})
}
