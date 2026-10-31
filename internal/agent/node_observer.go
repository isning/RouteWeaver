package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"routeweaver/internal/domain"
	"routeweaver/internal/observability"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// NodeCollector reads only five bounded procfs files. The reader can be a local
// /proc filesystem or a synthetic fixture; no shell, netlink, or network access.
type NodeCollector struct{ reader fs.FS }

func NewNodeCollector(reader fs.FS) *NodeCollector { return &NodeCollector{reader: reader} }
func NewLocalNodeCollector() (*NodeCollector, error) {
	if runtime.GOOS != "linux" {
		return nil, errors.New("node resource collection requires Linux procfs")
	}
	return NewNodeCollector(os.DirFS("/proc")), nil
}
func (c *NodeCollector) read(ctx context.Context, name string) (string, error) {
	if e := ctx.Err(); e != nil {
		return "", e
	}
	if c == nil || c.reader == nil {
		return "", errors.New("procfs reader required")
	}
	file, e := c.reader.Open(name)
	if e != nil {
		return "", fmt.Errorf("procfs %s unavailable: %w", name, e)
	}
	defer file.Close()
	b, e := io.ReadAll(io.LimitReader(file, (256<<10)+1))
	if e != nil {
		return "", fmt.Errorf("procfs %s read failed: %w", name, e)
	}
	if len(b) > 256<<10 {
		return "", fmt.Errorf("procfs %s exceeds bounded read", name)
	}
	if e = ctx.Err(); e != nil {
		return "", e
	}
	return string(b), nil
}
func (c *NodeCollector) Collect(ctx context.Context) (observability.Metrics, error) {
	var m observability.Metrics
	raw := map[string]string{}
	for _, path := range []string{"stat", "meminfo", "loadavg", "net/dev", "sys/kernel/random/boot_id"} {
		v, e := c.read(ctx, path)
		if e != nil {
			return m, e
		}
		raw[path] = v
	}
	m.CounterEpoch = strings.TrimSpace(raw["sys/kernel/random/boot_id"])
	if !domain.ValidID(m.CounterEpoch) {
		return m, errors.New("procfs boot counter epoch invalid")
	}
	cpu := strings.Fields(strings.SplitN(raw["stat"], "\n", 2)[0])
	if len(cpu) < 5 || cpu[0] != "cpu" {
		return m, errors.New("procfs aggregate CPU counters missing")
	}
	// Linux guest and guest_nice already occur in user and nice. Summing them
	// again would overstate CPU time. The first eight fields include steal.
	for i := 1; i < len(cpu) && i <= 8; i++ {
		v, e := strconv.ParseUint(cpu[i], 10, 64)
		if e != nil || m.CPUTotalTicks > math.MaxUint64-v {
			return m, errors.New("procfs CPU counters invalid")
		}
		m.CPUTotalTicks += v
		if i == 4 || i == 5 {
			m.CPUIdleTicks += v
		}
	}
	if m.CPUTotalTicks == 0 {
		return m, errors.New("procfs aggregate CPU counter unavailable")
	}
	found := map[string]bool{}
	for _, line := range strings.Split(raw["meminfo"], "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || (fields[0] != "MemTotal:" && fields[0] != "MemAvailable:") {
			continue
		}
		if len(fields) != 3 || fields[2] != "kB" || found[fields[0]] {
			return m, errors.New("procfs memory unit or field invalid")
		}
		n, e := strconv.ParseUint(fields[1], 10, 64)
		if e != nil || n > math.MaxUint64/1024 {
			return m, errors.New("procfs memory value invalid")
		}
		found[fields[0]] = true
		if fields[0] == "MemTotal:" {
			m.MemoryTotalBytes = n * 1024
		} else {
			m.MemoryAvailableBytes = n * 1024
		}
	}
	if !found["MemTotal:"] || !found["MemAvailable:"] || m.MemoryTotalBytes == 0 || m.MemoryAvailableBytes > m.MemoryTotalBytes {
		return m, errors.New("procfs memory total/available unavailable")
	}
	loads := strings.Fields(raw["loadavg"])
	if len(loads) < 3 {
		return m, errors.New("procfs load averages unavailable")
	}
	for i, target := range []*float64{&m.Load1, &m.Load5, &m.Load15} {
		v, e := strconv.ParseFloat(loads[i], 64)
		if e != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return m, errors.New("procfs load average invalid")
		}
		*target = v
	}
	m.Interfaces = []observability.Interface{}
	seen := map[string]bool{}
	for _, line := range strings.Split(raw["net/dev"], "\n") {
		if !strings.Contains(line, ":") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		name := strings.TrimSpace(parts[0])
		fields := strings.Fields(parts[1])
		if name == "" || len(name) > 64 || strings.ContainsAny(name, " /\\\t\r\n\x00") || seen[name] || len(fields) != 16 || len(m.Interfaces) >= 128 {
			return m, errors.New("procfs interface fields invalid or excessive")
		}
		seen[name] = true
		rx, e := strconv.ParseUint(fields[0], 10, 64)
		if e != nil {
			return m, errors.New("procfs receive counter invalid")
		}
		tx, e := strconv.ParseUint(fields[8], 10, 64)
		if e != nil {
			return m, errors.New("procfs transmit counter invalid")
		}
		m.Interfaces = append(m.Interfaces, observability.Interface{Name: name, ReceiveBytes: rx, TransmitBytes: tx})
	}
	if len(m.Interfaces) == 0 {
		return m, errors.New("procfs interface counters unavailable")
	}
	sort.Slice(m.Interfaces, func(i, j int) bool { return m.Interfaces[i].Name < m.Interfaces[j].Name })
	return m, nil
}

type NodeObservationTransport interface {
	ReportNodeObservation(context.Context, observability.Report) (observability.Receipt, error)
}

// NodeObserver is enabled only for the operator-designated core instance on a
// physical node. Failed sends keep the same sample/sequence for exact retry.
// Restart creates a new stream, which the control plane marks as a coverage gap.
type NodeObserver struct {
	mu        sync.Mutex
	scope     Scope
	collector *NodeCollector
	epoch     string
	sequence  uint64
	pending   *observability.Report
}

func NewNodeObserver(scope Scope, collector *NodeCollector) (*NodeObserver, error) {
	if !domain.ValidID(scope.NodeID) || !domain.ValidID(scope.InstanceID) || !domain.ValidID(scope.EnrollmentEpoch) || collector == nil {
		return nil, errors.New("enrolled observer scope and node collector required")
	}
	var id [16]byte
	if _, e := rand.Read(id[:]); e != nil {
		return nil, e
	}
	return &NodeObserver{scope: scope, collector: collector, epoch: "obs_" + hex.EncodeToString(id[:])}, nil
}
func (n *NodeObserver) Observe(ctx context.Context, tr NodeObservationTransport) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if tr == nil {
		return errors.New("node observation transport required")
	}
	// An unacknowledged old resource sample is not an accounting ledger. Rotate
	// its stream after a long outage so collection can recover without replaying
	// a permanently stale first sample. The server explicitly marks that gap.
	if n.pending != nil && time.Since(n.pending.ObservedAt) > observability.FreshFor {
		var id [16]byte
		if _, e := rand.Read(id[:]); e != nil {
			return e
		}
		n.epoch = "obs_" + hex.EncodeToString(id[:])
		n.sequence = 0
		n.pending = nil
	}
	if n.pending == nil {
		if n.sequence == math.MaxUint64 {
			return errors.New("node observation sequence exhausted")
		}
		metrics, e := n.collector.Collect(ctx)
		if e != nil {
			return e
		}
		r := observability.Report{Scope: observability.Scope(n.scope), StreamEpoch: n.epoch, Sequence: n.sequence + 1, ObservedAt: time.Now().UTC(), Metrics: metrics}
		r.Digest = observability.ReportDigest(r)
		n.pending = &r
	}
	receipt, e := tr.ReportNodeObservation(ctx, *n.pending)
	if e != nil {
		return e
	}
	if receipt.StreamEpoch != n.pending.StreamEpoch || receipt.Sequence != n.pending.Sequence || receipt.Digest != n.pending.Digest {
		return errors.New("node observation receipt mismatch")
	}
	n.sequence = n.pending.Sequence
	n.pending = nil
	return nil
}
