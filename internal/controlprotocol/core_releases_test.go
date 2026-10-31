package controlprotocol

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestOfficialCoreCatalogMatchesRepositoryReleasePins(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/core-lock.json")
	if err != nil {
		t.Fatal(err)
	}
	var lock struct {
		Platform string `json:"platform"`
		Cores    []struct {
			ID, Version, URL, ArchiveSHA256, ExecutableSHA256 string
			UpstreamChecksumVerified                          bool
		}
	}
	if err = json.Unmarshal(raw, &lock); err != nil {
		t.Fatal(err)
	}
	for _, release := range OfficialCoreReleases() {
		found := false
		for _, pin := range lock.Cores {
			if "routeweaver/"+pin.ID == release.AdapterID && pin.Version == release.Version {
				found = true
				if release.Platform != lock.Platform || release.URL != pin.URL || release.ArchiveSHA256 != pin.ArchiveSHA256 || release.ExecutableSHA256 != pin.ExecutableSHA256 || release.UpstreamChecksumVerified != pin.UpstreamChecksumVerified {
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
