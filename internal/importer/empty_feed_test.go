package importer_test

import (
	"routeweaver/internal/importer"
	"testing"
)

func TestRecognizedEmptyNativeFeedIsCompleteRemovalSnapshot(t *testing.T) {
	for _, input := range []string{`{"proxies":[]}`, "proxies: []\n", `{"outbounds":[]}`} {
		got, err := importer.Parse(importer.Request{SourceID: "source", OwnerID: "owner", SnapshotID: "snapshot", Format: "auto", Data: []byte(input)})
		if err != nil || !got.Complete || len(got.Snapshot.Endpoints) != 0 {
			t.Fatalf("explicit empty feed must be a complete empty snapshot: %q: %+v %v", input, got, err)
		}
	}
	for _, input := range []string{"", " \n", "# empty", "<html>login</html>", `{}`, `{"proxies":null}`, `{"outbounds":null}`, "proxies:\n", `{"proxies":{}}`} {
		if _, err := importer.Parse(importer.Request{SourceID: "source", OwnerID: "owner", SnapshotID: "snapshot", Format: "auto", Data: []byte(input)}); err == nil {
			t.Fatalf("malformed or ambiguous empty input accepted: %q", input)
		}
	}
}
