package controlprotocol

import "fmt"

// CoreRelease is a build-reviewed immutable upstream release, not a command or
// caller-supplied download location. IDs are deliberately open catalog keys.
// A checksum pins bytes; it does not claim a cryptographic publisher signature.
type CoreRelease struct {
	ID                       string `json:"id"`
	AdapterID                string `json:"adapterId"`
	Version                  string `json:"version"`
	Platform                 string `json:"platform"`
	URL                      string `json:"url"`
	ArchiveFormat            string `json:"archiveFormat"`
	ExecutablePath           string `json:"executablePath"`
	ArchiveSHA256            string `json:"archiveSHA256"`
	ExecutableSHA256         string `json:"executableSHA256"`
	UpstreamChecksumVerified bool   `json:"upstreamChecksumVerified"`
}

var officialCoreReleases = []CoreRelease{
	{ID: "xray-26.3.27-linux-amd64", AdapterID: "routeweaver/xray", Version: "26.3.27", Platform: "linux-amd64", URL: "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip", ArchiveFormat: "zip", ExecutablePath: "xray", ArchiveSHA256: "23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae", ExecutableSHA256: "8255dd939c34cf966cc91517b6324dd3c8d0bcf49ffac8beca049a38c46845ed", UpstreamChecksumVerified: true},
	{ID: "sing-box-1.14.3-linux-amd64", AdapterID: "routeweaver/sing-box", Version: "1.14.3", Platform: "linux-amd64", URL: "https://github.com/SagerNet/sing-box/releases/download/v1.14.3/sing-box-1.14.3-linux-amd64.tar.gz", ArchiveFormat: "tar.gz", ExecutablePath: "sing-box-1.14.3-linux-amd64/sing-box", ArchiveSHA256: "e2bdf179c15a3652955dc44867e33ca0965c9c9b91b34267dcc5a5d639a5feee", ExecutableSHA256: "768d31fa7f68debc067bb4626539498a1e8751d36a7b99e1a54bee6a23815f93"},
}

func OfficialCoreReleases() []CoreRelease { return append([]CoreRelease(nil), officialCoreReleases...) }
func FindCoreRelease(id string) (CoreRelease, error) {
	for _, release := range officialCoreReleases {
		if release.ID == id {
			return release, nil
		}
	}
	return CoreRelease{}, fmt.Errorf("core release %q is not in the reviewed official catalog; choose a listed adapter, version and platform", id)
}

func validateCoreLifecycle(d Desired, scope Scope) error {
	switch d.Action {
	case "", "configure", "start", "stop", "rollback", "install", "upgrade":
	default:
		return fmt.Errorf("unsupported lifecycle action %q", d.Action)
	}
	if d.Action == "stop" && d.Lease.AccessAllowed {
		return fmt.Errorf("stop action must revoke access in its policy lease")
	}
	if d.CoreReleaseID != "" {
		release, err := FindCoreRelease(d.CoreReleaseID)
		if err != nil {
			return err
		}
		if release.AdapterID != d.AdapterID || release.Version != d.CoreVersion {
			return fmt.Errorf("core release does not match desired adapter and version")
		}
		if d.Transition != nil && (d.Transition.ReleaseID != release.ID || d.Transition.ExecutableSHA256 != release.ExecutableSHA256) {
			return fmt.Errorf("transition does not bind the catalog executable digest")
		}
	}
	if (d.Action == "install" || d.Action == "upgrade") && d.CoreReleaseID == "" {
		return fmt.Errorf("install and upgrade require a reviewed core release")
	}
	if d.Action == "upgrade" && d.Transition == nil {
		return fmt.Errorf("upgrade requires an explicit previous runtime identity")
	}
	if transition := d.Transition; transition != nil {
		from := transition.From
		if d.Action == "install" || d.Action == "stop" || from.Scope != scope || from.Generation == 0 || from.Generation >= d.Generation || from.RevisionID == "" || from.OperationID == "" || len(from.Digest) != 64 {
			return fmt.Errorf("invalid previous runtime transition identity")
		}
		if from.AdapterID == d.AdapterID && from.CoreVersion == d.CoreVersion {
			return fmt.Errorf("core transition must change adapter or version")
		}
		if d.CoreReleaseID == "" && (transition.ReleaseID != "" || transition.ExecutableSHA256 != "") {
			return fmt.Errorf("transition release requires the matching reviewed catalog entry")
		}
	}
	return nil
}
