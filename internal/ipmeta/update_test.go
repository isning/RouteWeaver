package ipmeta

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"github.com/oschwald/maxminddb-golang/v2"
	"io"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"
)

func TestAutomaticDatabaseStartsUnavailableWithoutCache(t *testing.T) {
	updater, err := NewUpdater(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if updater.Database().Snapshot() != nil {
		t.Fatal("invented availability before download")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := updater.Refresh(ctx); err == nil {
		t.Fatal("canceled download succeeded")
	}
	if updater.Database().Snapshot() != nil {
		t.Fatal("failed refresh became available")
	}
}

// The transport seam supplies small official MaxMind test fixtures, with only
// their metadata type/date changed to match the DB-IP compatible schema.
func releaseFixture(t *testing.T, kind string, now time.Time) []byte {
	t.Helper()
	path, old, typ := "testdata/GeoIP2-Country-Test.mmdb", "GeoIP2-Country", "DBIP-Country-Lite"
	if kind == "asn" {
		path, old, typ = "testdata/GeoLite2-ASN-Test.mmdb", "GeoLite2-ASN", "DBIP-ASN-Lite (compat=GeoLite2-ASN)"
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	r, err := maxminddb.OpenBytes(b)
	if err != nil {
		t.Fatal(err)
	}
	m := r.Metadata
	marker := []byte("\xab\xcd\xefMaxMind.com")
	pos := bytes.LastIndex(b, marker) + len(marker)
	b = append(b[:pos], encodeMetadata(map[string]any{
		"binary_format_major_version": uint16(m.BinaryFormatMajorVersion), "binary_format_minor_version": uint16(m.BinaryFormatMinorVersion),
		"build_epoch": uint64(now.Unix()), "database_type": typ, "description": map[string]any{"en": "Test fixture"},
		"ip_version": uint16(m.IPVersion), "languages": []string{"en"}, "node_count": uint32(m.NodeCount), "record_size": uint16(m.RecordSize),
	})...)
	_ = old

	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	_, _ = gz.Write(b)
	_ = gz.Close()
	return out.Bytes()
}

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAutomaticUpdatePublishesPairAndKeepsLastGoodOnFailure(t *testing.T) {
	now := time.Now().UTC()
	dir := t.TempDir()
	u, err := NewUpdater(dir)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	broken := false
	u.now = func() time.Time { return now }
	u.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Scheme != "https" || r.URL.Host != "download.db-ip.com" || r.URL.RawQuery != "" {
			t.Fatalf("unexpected destination %s", r.URL)
		}
		kind := "country"
		if strings.Contains(r.URL.Path, "-asn-") {
			kind = "asn"
		}
		data := releaseFixture(t, kind, now)
		if broken && kind == "asn" {
			data = []byte("bad gzip")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data))}, nil
	})
	if err = u.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	pinned := u.Database().Snapshot()
	if pinned.Lookup(netip.MustParseAddr("81.2.69.142")).CountryCode != "GB" || pinned.Lookup(netip.MustParseAddr("1.0.0.1")).ASN != 15169 {
		t.Fatal("pair not available")
	}
	if pinned.Sources()[0].AttributionURL != "https://db-ip.com" {
		t.Fatal("missing attribution")
	}
	if err = u.Refresh(context.Background()); err != nil || calls != 2 {
		t.Fatal("download repeated for current release")
	}
	reloaded, err := NewUpdater(dir)
	if err != nil || reloaded.Database().Snapshot() == nil {
		t.Fatal("cache not recovered")
	}
	now = now.AddDate(0, 1, 0)
	broken = true
	if err = u.Refresh(context.Background()); err == nil {
		t.Fatal("corrupt update accepted")
	}
	if u.Database().Snapshot() != pinned {
		t.Fatal("failure replaced last good data")
	}
	reloaded, err = NewUpdater(dir)
	if err != nil || reloaded.Database().Sources()[0].BuiltAt != pinned.Sources()[0].BuiltAt {
		t.Fatal("failure changed persistent pair")
	}
}

func encodeMetadata(v any) []byte {
	head := func(typ, n byte) []byte {
		if typ > 7 {
			return []byte{n, typ - 7}
		}
		if n >= 29 {
			return []byte{typ<<5 | 29, n - 29}
		}
		return []byte{typ<<5 | n}
	}
	switch x := v.(type) {
	case string:
		return append(head(2, byte(len(x))), []byte(x)...)
	case uint16:
		return append(head(5, 2), byte(x>>8), byte(x))
	case uint32:
		b := make([]byte, 4)
		binary.BigEndian.PutUint32(b, x)
		return append(head(6, 4), b...)
	case uint64:
		b := make([]byte, 8)
		binary.BigEndian.PutUint64(b, x)
		return append(head(9, 8), b...)
	case []string:
		b := head(11, byte(len(x)))
		for _, s := range x {
			b = append(b, encodeMetadata(s)...)
		}
		return b
	case map[string]any:
		b := head(7, byte(len(x)))
		for k, v := range x {
			b = append(b, encodeMetadata(k)...)
			b = append(b, encodeMetadata(v)...)
		}
		return b
	}
	panic("unsupported metadata")
}

func TestAutomaticUpdateRejectsUnsafeOrCorruptDownloads(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		length int64
		body   []byte
	}{
		{"redirect", 302, 0, nil}, {"missing release", 404, 0, nil}, {"oversized compressed", 200, downloadLimit + 1, nil}, {"not gzip", 200, 3, []byte("bad")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u, err := NewUpdater(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			u.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tc.status, ContentLength: tc.length, Body: io.NopCloser(bytes.NewReader(tc.body)), Header: http.Header{"Location": []string{"https://example.com/elsewhere"}}}, nil
			})
			if err = u.Refresh(context.Background()); err == nil {
				t.Fatal("unsafe response accepted")
			}
			if u.Database().Snapshot() != nil {
				t.Fatal("failed download became available")
			}
		})
	}
}

func TestAutomaticUpdateRejectsExpandedLimitChecksumAndWrongMonth(t *testing.T) {
	now := time.Now().UTC()
	for _, kind := range []string{"expanded-limit", "checksum", "wrong-month"} {
		t.Run(kind, func(t *testing.T) {
			u, err := NewUpdater(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			u.now = func() time.Time { return now }
			var data []byte
			switch kind {
			case "expanded-limit":
				var b bytes.Buffer
				gz := gzip.NewWriter(&b)
				block := make([]byte, 1<<20)
				for i := 0; i < 129; i++ {
					_, _ = gz.Write(block)
				}
				_ = gz.Close()
				data = b.Bytes()
			case "checksum":
				data = releaseFixture(t, "country", now)
				data[len(data)-8] ^= 0x80
			}
			u.client.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
				body := data
				if kind == "wrong-month" {
					dbkind := "country"
					if strings.Contains(r.URL.Path, "-asn-") {
						dbkind = "asn"
					}
					body = releaseFixture(t, dbkind, now.AddDate(0, -1, 0))
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body))}, nil
			})
			if err = u.Refresh(context.Background()); err == nil {
				t.Fatal("invalid database accepted")
			}
			if u.Database().Snapshot() != nil {
				t.Fatal("invalid pair published")
			}
		})
	}
}
