package httpapi

import (
	"encoding/json"
	"gopkg.in/yaml.v3"
	"net/http"
	"routeweaver/internal/resources"
	"time"
)

// Inspection downloads only through the bounded SSRF-safe fetcher. A digest
// attests accepted bytes, not native-rule semantics or future remote contents.
func (h *server) inspectResource(w http.ResponseWriter, r *http.Request) {
	var in struct {
		URL    string `json:"url"`
		Format string `json:"format"`
	}
	if !decode(w, r, &in) {
		return
	}
	switch in.Format {
	case "sing-box-source", "mihomo-yaml", "mihomo-text", "srs", "mrs":
	default:
		fail(w, 400, "select a supported rule resource format")
		return
	}
	v, e := resources.New(resources.Options{MaxBytes: 8 << 20, Timeout: 15 * time.Second}).Fetch(r.Context(), in.URL)
	if e != nil {
		fail(w, 422, e.Error())
		return
	}
	version, inspection, err := resources.InspectRuleFile(in.Format, v.Body)
	if err != nil {
		fail(w, 422, err.Error())
		return
	}
	count := 0
	switch in.Format {
	case "sing-box-source":
		var body struct {
			Version int               `json:"version"`
			Rules   []json.RawMessage `json:"rules"`
		}
		if json.Unmarshal(v.Body, &body) != nil || body.Version < 1 || body.Version > 5 || body.Rules == nil {
			fail(w, 422, "invalid sing-box rule-set source envelope")
			return
		}
		version = body.Version
		count = len(body.Rules)
	case "mihomo-yaml":
		var body struct {
			Payload []string `yaml:"payload"`
		}
		if yaml.Unmarshal(v.Body, &body) != nil || body.Payload == nil {
			fail(w, 422, "invalid Mihomo YAML rule payload")
			return
		}
		count = len(body.Payload)
	}
	writeJSON(w, 200, map[string]any{"digest": "sha256:" + v.SHA256, "format": in.Format, "formatVersion": version, "bytes": len(v.Body), "entries": count, "inspection": inspection, "nativeChecked": false})
}
