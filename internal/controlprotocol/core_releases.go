package controlprotocol

import (
	"errors"
	"fmt"
)

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
	{ID: "xray-26.10.29-linux-amd64", AdapterID: "routeweaver/xray", Version: "26.10.29", Platform: "linux-amd64", URL: "https://github.com/XTLS/Xray-core/releases/download/v26.10.29/Xray-linux-64.zip", ArchiveFormat: "zip", ExecutablePath: "xray", ArchiveSHA256: "8a5f3e6a1057e4bd0f8a7c57c9d91204b4be0b74222a6e210d070603101163c2", ExecutableSHA256: "e783b9d2b46ed1ab3617c59b04dfbce38c999322d018c6e060f18d88bf6158aa", UpstreamChecksumVerified: true},
	{ID: "sing-box-1.14.4-linux-amd64", AdapterID: "routeweaver/sing-box", Version: "1.14.4", Platform: "linux-amd64", URL: "https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-linux-amd64.tar.gz", ArchiveFormat: "tar.gz", ExecutablePath: "sing-box-1.14.4-linux-amd64/sing-box", ArchiveSHA256: "699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968", ExecutableSHA256: "1264361b5f8868c8768f7555d3e77e20118bf503c41ac08bb290a0d99056aa3a", UpstreamChecksumVerified: true},
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

// Installability is policy, not immutable receipt metadata. Retired releases
// remain resolvable to verify and recover already installed runtimes.
func InstallableCoreReleases() []CoreRelease {
	out := []CoreRelease{}
	for _, release := range officialCoreReleases {
		if installableCoreReleaseID(release.ID) {
			out = append(out, release)
		}
	}
	return out
}
func installableCoreReleaseID(id string) bool {
	switch id {
	case "xray-26.10.29-linux-amd64", "sing-box-1.14.4-linux-amd64":
		return true
	}
	return false
}

// ErrCoreReleaseRetired distinguishes a terminal policy rejection from an
// uncertain recovery error; callers must still preserve their generation fence.
var ErrCoreReleaseRetired = errors.New("core release retired for new installation and upgrade")

func FindInstallableCoreRelease(id string) (CoreRelease, error) {
	release, err := FindCoreRelease(id)
	if err != nil {
		return CoreRelease{}, err
	}
	if !installableCoreReleaseID(id) {
		return CoreRelease{}, fmt.Errorf("%w: %q; choose a current reviewed release", ErrCoreReleaseRetired, id)
	}
	return release, nil
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
