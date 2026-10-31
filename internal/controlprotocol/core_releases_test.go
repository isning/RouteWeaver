package controlprotocol

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestOfficialCoreCatalogMatchesRepositoryReleasePins(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/stock-core-lock.json")
	if err != nil {
		t.Fatal(err)
	}
	var lock struct {
		Releases []CoreRelease `json:"releases"`
	}
	if err = json.Unmarshal(raw, &lock); err != nil {
		t.Fatal(err)
	}
	if len(lock.Releases) != len(OfficialCoreReleases()) {
		t.Fatal("stock lock/catalog cardinality differs")
	}
	seen := map[string]bool{}
	for _, pin := range lock.Releases {
		if seen[pin.ID] {
			t.Fatal("duplicate stock lock identity", pin.ID)
		}
		seen[pin.ID] = true
	}
	for _, release := range OfficialCoreReleases() {
		found := false
		for _, pin := range lock.Releases {
			if pin.ID == release.ID {
				found = true
				if release != pin {
					t.Fatalf("installer catalog drifted from native gate pin: %s", release.ID)
				}
			}
		}
		if !found {
			t.Fatalf("installer release has no reviewed repository pin: %s", release.ID)
		}
		if strings.Contains(release.AdapterID, "managed") {
			t.Fatal("unpublished managed runtime was presented as official upstream release")
		}
	}
}

func TestInstallableCatalogRetainsHistoricalReceiptIdentities(t *testing.T) {
	active := InstallableCoreReleases()
	if len(active) != 2 || active[0].ID != "xray-26.10.29-linux-amd64" || active[1].ID != "sing-box-1.14.4-linux-amd64" {
		t.Fatalf("unexpected current installation choices: %+v", active)
	}
	for _, id := range []string{"xray-26.3.27-linux-amd64", "sing-box-1.14.3-linux-amd64"} {
		if _, err := FindCoreRelease(id); err != nil {
			t.Fatal("historical receipt cannot be resolved", err)
		}
		if _, err := FindInstallableCoreRelease(id); err == nil {
			t.Fatal("retired release is installable", id)
		}
	}
	active[0].Version = "changed"
	if unchanged, _ := FindInstallableCoreRelease("xray-26.10.29-linux-amd64"); unchanged.Version != "26.10.29" {
		t.Fatal("caller mutated catalog")
	}
}
