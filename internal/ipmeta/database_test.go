package ipmeta_test

import (
	"net/netip"
	"os"
	"path/filepath"
	"routeweaver/internal/ipmeta"
	"testing"
)

func TestLocalMetadataIsOptionalVerifiedAndNeverInfersMissingData(t *testing.T) {
	empty, err := ipmeta.Open("", "")
	if err != nil || empty != nil || empty.Lookup(netip.MustParseAddr("81.2.69.142")).Status != "unavailable" {
		t.Fatal("optional metadata not unavailable")
	}
	db, err := ipmeta.Open("testdata/GeoIP2-Country-Test.mmdb", "")
	if err != nil {
		t.Fatal(err)
	}
	got := db.Lookup(netip.MustParseAddr("81.2.69.142"))
	if got.Status != "available" || got.CountryCode != "GB" || got.ASN != 0 || got.Organization != "" {
		t.Fatalf("country result %+v", got)
	}
	for _, raw := range []string{"127.0.0.1", "10.2.3.4", "192.0.2.1", "100.64.1.1", "2001:db8::1", "fe80::1%eth0", "::ffff:10.0.0.1"} {
		if got := db.Lookup(netip.MustParseAddr(raw)); got.Status != "non-public" {
			t.Fatalf("public inference %s %+v", raw, got)
		}
	}
	if got := db.Lookup(netip.MustParseAddr("1.0.0.1")); got.CountryCode != "" || got.Status != "not-found" {
		t.Fatalf("missing record guessed: %+v", got)
	}
	sources := db.Sources()
	if len(sources) != 1 || sources[0].DatabaseType != "GeoIP2-Country" || sources[0].BuiltAt.IsZero() {
		t.Fatal("missing provenance")
	}
	sources[0].DatabaseType = "corrupt"
	if db.Sources()[0].DatabaseType == "corrupt" {
		t.Fatal("mutable source metadata")
	}
	if _, err := ipmeta.Open("", "testdata/GeoIP2-Country-Test.mmdb"); err == nil {
		t.Fatal("wrong schema accepted")
	}
	bad := filepath.Join(t.TempDir(), "bad.mmdb")
	os.WriteFile(bad, []byte("invalid"), 0600)
	if _, err := ipmeta.Open(bad, ""); err == nil {
		t.Fatal("invalid database accepted")
	}
	if _, err := ipmeta.Open(t.TempDir(), ""); err == nil {
		t.Fatal("directory accepted")
	}
}
func TestDatabaseUsesPrivateSnapshot(t *testing.T) {
	data, err := os.ReadFile("testdata/GeoIP2-Country-Test.mmdb")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "country.mmdb")
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	db, err := ipmeta.Open(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("replaced"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := db.Lookup(netip.MustParseAddr("81.2.69.142")); got.CountryCode != "GB" {
		t.Fatal("file replacement changed verified snapshot")
	}
}

func TestLocalASNAndBoundedFileLoading(t *testing.T) {
	db, err := ipmeta.Open("", "testdata/GeoLite2-ASN-Test.mmdb")
	if err != nil {
		t.Fatal(err)
	}
	got := db.Lookup(netip.MustParseAddr("1.0.0.1"))
	if got.Status != "available" || got.ASN != 15169 || got.Organization != "Google Inc." || got.CountryCode != "" {
		t.Fatalf("ASN fixture: %+v", got)
	}
	path := filepath.Join(t.TempDir(), "oversized.mmdb")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Truncate(ipmeta.MaxDatabaseBytes + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, err = ipmeta.Open(path, ""); err == nil {
		t.Fatal("oversized file accepted")
	}
}
