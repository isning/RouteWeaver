package httpapi

import (
	"routeweaver/internal/ipmeta"
	"testing"
)

func TestIPMetadataOptionalBoundedAndLocal(t *testing.T) {
	h := &server{}
	out := h.ipMetadata([]string{"81.2.69.142"})
	if out.Available || len(out.Items) != 0 {
		t.Fatalf("unconfigured: %+v", out)
	}
	db, err := ipmeta.Open("../ipmeta/testdata/GeoIP2-Country-Test.mmdb", "")
	if err != nil {
		t.Fatal(err)
	}
	h.opts.IPMetadata = db
	out = h.ipMetadata([]string{"81.2.69.142", "127.0.0.1", "invalid"})
	if !out.Available || len(out.Items) != 2 || out.Items[0].CountryCode != "GB" || out.Items[1].Status != "non-public" {
		t.Fatalf("lookup: %+v", out)
	}
	addresses := make([]string, 101)
	for i := range addresses {
		addresses[i] = "81.2.69.142"
	}
	out = h.ipMetadata(addresses)
	if !out.Truncated || len(out.Items) != 100 {
		t.Fatalf("bound: %+v", out)
	}
}
