package importer

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/netip"
	"strings"

	"routeweaver/internal/domain"
)

func locationKey(source string, c domain.Connection) string {
	host := strings.TrimSuffix(strings.ToLower(c.Host), ".")
	if ip, err := netip.ParseAddr(host); err == nil {
		host = ip.Unmap().String()
	}
	// No credential or optional transport field contributes to exported IDs.
	// Paths, REALITY short IDs and public-key material can rotate independently.
	b, _ := json.Marshal(struct {
		Source, Protocol, Host string
		Port                   int
	}{source, c.Protocol, host, c.Port})
	sum := sha256.Sum256(b)
	return "ep_" + hex.EncodeToString(sum[:16])
}
func sameConnection(a, b domain.Connection) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}

// Reconciliation compares private connection values only to match an existing
// random identity; credentials are never hashed into or exposed as that identity.
// Unique locations retain identity across credential rotation. Ambiguous bulk
// changes preserve the prior snapshot instead of silently swapping identities.
func assignIdentities(req Request, nodes []candidate) ([]string, error) {
	ids := make([]string, len(nodes))
	groups := map[string][]int{}
	old := map[string][]domain.ClientEndpoint{}
	used := map[string]bool{}
	if req.Previous != nil {
		if req.Previous.SourceID != req.SourceID || req.Previous.OwnerID != req.OwnerID {
			return nil, fmt.Errorf("%w: prior snapshot ownership mismatch", ErrInput)
		}
		for _, e := range req.Previous.Endpoints {
			if !domain.ValidID(e.ID) || e.OwnerID != req.OwnerID || e.Origin != "imported" || used[e.ID] {
				return nil, fmt.Errorf("%w: prior snapshot identity invalid", ErrInput)
			}
			used[e.ID] = true
			key := locationKey(req.SourceID, e.Connection)
			old[key] = append(old[key], e)
		}
	}
	for i, n := range nodes {
		key := locationKey(req.SourceID, n.Connection)
		groups[key] = append(groups[key], i)
	}
	for key, indexes := range groups {
		prior := old[key]
		matched := make([]bool, len(prior))
		for _, i := range indexes {
			// Prefer an unchanged label only to disambiguate otherwise identical
			// connection values, then preserve identity under a display rename.
			choice := -1
			for j, e := range prior {
				if !matched[j] && sameConnection(nodes[i].Connection, e.Connection) {
					if choice < 0 {
						choice = j
					}
					if nodes[i].Name == e.Name {
						choice = j
						break
					}
				}
			}
			if choice >= 0 {
				ids[i] = prior[choice].ID
				matched[choice] = true
			}
		}
		remainingNew := []int{}
		remainingOld := []int{}
		for _, i := range indexes {
			if ids[i] == "" {
				remainingNew = append(remainingNew, i)
			}
		}
		for j := range prior {
			if !matched[j] {
				remainingOld = append(remainingOld, j)
			}
		}
		if len(remainingNew) == 1 && len(remainingOld) == 1 {
			ids[remainingNew[0]] = prior[remainingOld[0]].ID
			remainingNew = nil
			remainingOld = nil
		}
		if len(remainingNew) > 0 && len(remainingOld) > 0 {
			return nil, fmt.Errorf("%w: ambiguous connection identity changes; keep previous snapshot and resolve changed entries", ErrInput)
		}
		for _, i := range remainingNew {
			if len(indexes) == 1 && !used[key] {
				ids[i] = key
				used[key] = true
				continue
			}
			for {
				var bytes [16]byte
				if _, err := rand.Read(bytes[:]); err != nil {
					return nil, fmt.Errorf("cannot allocate imported connection identity")
				}
				id := "ep_" + hex.EncodeToString(bytes[:])
				if !used[id] {
					used[id] = true
					ids[i] = id
					break
				}
			}
		}
	}
	return ids, nil
}
