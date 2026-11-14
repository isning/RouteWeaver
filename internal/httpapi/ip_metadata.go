package httpapi

import (
	"net/netip"
	"routeweaver/internal/ipmeta"
)

type ipMetadataItem struct {
	IP string `json:"ip"`
	ipmeta.Result
}
type ipMetadataView struct {
	Available bool             `json:"available"`
	Sources   []ipmeta.Source  `json:"sources"`
	Items     []ipMetadataItem `json:"items"`
	Truncated bool             `json:"truncated"`
}

// Call only with server-derived addresses already authorized for this account.
// Never provides an arbitrary IP lookup endpoint or sends addresses over a network.
func (h *server) ipMetadata(ips []string) ipMetadataView {
	out := ipMetadataView{Available: h.opts.IPMetadata != nil, Sources: h.opts.IPMetadata.Sources(), Items: []ipMetadataItem{}}
	if h.opts.IPMetadata == nil {
		return out
	}
	if len(ips) > 100 {
		ips = ips[:100]
		out.Truncated = true
	}
	for _, raw := range ips {
		ip, err := netip.ParseAddr(raw)
		if err != nil {
			continue
		}
		out.Items = append(out.Items, ipMetadataItem{IP: ip.Unmap().String(), Result: h.opts.IPMetadata.Lookup(ip)})
	}
	return out
}
