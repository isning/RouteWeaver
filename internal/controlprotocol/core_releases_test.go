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
		Releases    []CoreRelease `json:"releases"`
		Unavailable []string      `json:"unavailableFixtureReleaseIDs"`
	}
	if err = json.Unmarshal(raw, &lock); err != nil {
		t.Fatal(err)
	}
	if len(lock.Releases) != len(OfficialCoreReleases()) {
		t.Fatal("stock lock/catalog cardinality differs")
	}
	if len(lock.Unavailable) != 1 || lock.Unavailable[0] != "xray-26.10.29-linux-amd64" {
		t.Fatal("withdrawn fixture policy must not hide required available releases")
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
	if len(active) != 2 || active[0].ID != "xray-26.10.31-linux-amd64" || active[1].ID != "sing-box-1.14.4-linux-amd64" {
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
	if unchanged, _ := FindInstallableCoreRelease("xray-26.10.31-linux-amd64"); unchanged.Version != "26.10.31" {
		t.Fatal("caller mutated catalog")
	}
}

func TestWithdrawnXrayKeepsReceiptButCannotGrantNewActivation(t *testing.T) {
	old, err := FindCoreRelease("xray-26.10.29-linux-amd64")
	if err != nil || old.ExecutableSHA256 != "e783b9d2b46ed1ab3617c59b04dfbce38c999322d018c6e060f18d88bf6158aa" {
		t.Fatalf("withdrawn immutable receipt lost: %+v %v", old, err)
	}
	if _, err = FindInstallableCoreRelease(old.ID); err == nil {
		t.Fatal("withdrawn release installable")
	}
	if !CoreActivationWithdrawn(old.AdapterID, old.Version) || CoreActivationWithdrawn("routeweaver/xray", "26.3.27-rw1") {
		t.Fatal("withdrawal must bind exact stock identity")
	}
	current, err := FindInstallableCoreRelease("xray-26.10.31-linux-amd64")
	if err != nil || current.ExecutableSHA256 != "cc4b84d3069569f297a61f04b914f2bb37e9d202fd7b84cb50def1fc30fd40e1" {
		t.Fatalf("current reviewed release missing: %+v %v", current, err)
	}
}
