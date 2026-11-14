// Package ipmeta enriches IP addresses from explicitly supplied local databases.
// It has no network client, database downloader or request logging.
package ipmeta

import (
	"fmt"
	"io"
	"net/netip"
	"os"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/oschwald/maxminddb-golang/v2"
)

const MaxDatabaseBytes int64 = 128 << 20

type Source struct {
	Kind         string    `json:"kind"`
	DatabaseType string    `json:"databaseType"`
	BuiltAt      time.Time `json:"builtAt"`
}
type Result struct {
	Status       string `json:"status"`
	CountryCode  string `json:"countryCode,omitempty"`
	ASN          uint   `json:"asn,omitempty"`
	Organization string `json:"organization,omitempty"`
}

// Database owns immutable private copies. It is safe for concurrent lookup.
// Lifetime is the process lifetime; no mmap or mutable caller slices are kept.
type Database struct {
	country, asn *maxminddb.Reader
	sources      []Source
}

func Open(countryPath, asnPath string) (*Database, error) {
	if countryPath == "" && asnPath == "" {
		return nil, nil
	}
	d := &Database{}
	for _, item := range []struct {
		path, kind string
		dest       **maxminddb.Reader
	}{{countryPath, "country", &d.country}, {asnPath, "asn", &d.asn}} {
		if item.path == "" {
			continue
		}
		r, err := readDatabase(item.path, item.kind)
		if err != nil {
			return nil, fmt.Errorf("%s database: %w", item.kind, err)
		}
		*item.dest = r
		d.sources = append(d.sources, Source{Kind: item.kind, DatabaseType: r.Metadata.DatabaseType, BuiltAt: time.Unix(int64(r.Metadata.BuildEpoch), 0).UTC()})
	}
	return d, nil
}
func readDatabase(path, kind string) (*maxminddb.Reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("cannot open local file")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > MaxDatabaseBytes {
		return nil, fmt.Errorf("requires a nonempty regular file no larger than 128 MiB")
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxDatabaseBytes+1))
	if err != nil || int64(len(b)) > MaxDatabaseBytes {
		return nil, fmt.Errorf("cannot read bounded local file")
	}
	r, err := maxminddb.OpenBytes(b)
	if err != nil {
		return nil, fmt.Errorf("invalid MMDB file")
	}
	if err = r.Verify(); err != nil {
		return nil, fmt.Errorf("MMDB verification failed")
	}
	typ := r.Metadata.DatabaseType
	if (kind == "country" && typ != "GeoIP2-Country" && typ != "GeoLite2-Country") || (kind == "asn" && typ != "GeoLite2-ASN" && typ != "GeoIP2-ASN") {
		return nil, fmt.Errorf("unexpected database type")
	}
	if r.Metadata.BuildEpoch == 0 || uint64(r.Metadata.BuildEpoch) > uint64(time.Now().Add(24*time.Hour).Unix()) {
		return nil, fmt.Errorf("invalid database build date")
	}
	return r, nil
}
func (d *Database) Sources() []Source {
	if d == nil {
		return []Source{}
	}
	return append([]Source{}, d.sources...)
}

var nonPublic = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001:db8::/32"),
}

func (d *Database) Lookup(ip netip.Addr) Result {
	if d == nil {
		return Result{Status: "unavailable"}
	}
	ip = ip.Unmap()
	if !ip.IsValid() || ip.Zone() != "" || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return Result{Status: "non-public"}
	}
	for _, p := range nonPublic {
		if p.Contains(ip) {
			return Result{Status: "non-public"}
		}
	}
	out := Result{Status: "not-found"}
	if d.country != nil {
		var v struct {
			Country struct {
				ISOCode string `maxminddb:"iso_code"`
			} `maxminddb:"country"`
		}
		if err := d.country.Lookup(ip).Decode(&v); err != nil {
			return Result{Status: "unavailable"}
		}
		if len(v.Country.ISOCode) == 2 && v.Country.ISOCode[0] >= 'A' && v.Country.ISOCode[0] <= 'Z' && v.Country.ISOCode[1] >= 'A' && v.Country.ISOCode[1] <= 'Z' {
			out.CountryCode = v.Country.ISOCode
		}
	}
	if d.asn != nil {
		var v struct {
			ASN          uint   `maxminddb:"autonomous_system_number"`
			Organization string `maxminddb:"autonomous_system_organization"`
		}
		if err := d.asn.Lookup(ip).Decode(&v); err != nil {
			return Result{Status: "unavailable"}
		}
		if v.ASN > 0 && v.ASN <= 4294967295 {
			out.ASN = v.ASN
		}
		if out.ASN != 0 && len(v.Organization) <= 256 && utf8.ValidString(v.Organization) && strings.IndexFunc(v.Organization, unicode.IsControl) < 0 {
			out.Organization = v.Organization
		}
	}
	if out.CountryCode != "" || out.ASN != 0 {
		out.Status = "available"
	}
	return out
}
